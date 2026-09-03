/**
 * dsh-client.ts — stdio JSON-RPC 2.0 客户端 for the pi-web-ui DSH runtime
 * (server/dsh/runtime/launcher.mjs).
 *
 * 协议（每行一个紧凑 JSON 帧，见 dsh-sdk-jsonrpc-server）：
 *   client→server  initialize        → { serverInfo }
 *   client→server  session/prompt    → { messageId }（持久化入队回执）
 *   client→server  shutdown          → {}（运行时有序释放后 exit 0）
 *   server→client  session.event     （每个会话，全量持久事件）
 *   server→client  session.status    （running/idle 转换）
 *   server→client  subagent.started / subagent.finished
 *
 * 官方协议面限制（dsh 0.1.1-rc.2）：无 per-session close、无 prompt 取消、
 * 无 per-prompt 结果。因此：
 *   - 中止 = kill 进程树（会话 JSONL 在磁盘，进程重建不丢）
 *   - 换模型 = 重启运行时（model 在 initialize 固定）
 *   - 会话列表/回放 = 直读 JSONL（见 dsh-serialize.ts）
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 项目依赖解析（tsc 编译后 dist/server/dsh/ 里向上找 node_modules）。 */
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

/** 读取 DeepSeek API key：<agentDir>/auth.json 的 deepseek.key（ds-web-ui 同款）。
 *  agentDir 缺省为 ~/.pi/agent（尊重 PI_CODING_AGENT_DIR 由调用方传入）。 */
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
	/** 智能体工作区（initialize.cwd + DSH_CWD）。 */
	cwd: string;
	/** provider 路由（deepseek-official）。 */
	provider?: string;
	/** 模型 id（deepseek-v4-flash / deepseek-v4-pro）。 */
	model?: string;
	/** 每次请求输出上限。 */
	maxTokens?: number;
	/** DSH_SESSION_ROOT：JSONL 会话持久化根。 */
	sessionRoot?: string;
	/** pi-web-ui 数据目录（launcher 从中读 <dataDir>/dsh-patches/*.yml 用户 patch）。 */
	dataDir?: string;
	/** pi 配置目录（auth.json 所在；默认 ~/.pi/agent，尊重 PI_CODING_AGENT_DIR）。 */
	agentDir?: string;
	/** launcher.mjs 绝对路径（默认 server/dsh/runtime/launcher.mjs）。 */
	launcher?: string;
	/** 额外环境变量（DEEPSEEK_API_KEY 等）。 */
	env?: Record<string, string | undefined>;
	/** jsonrpc 插件入口（默认项目 node_modules）。 */
	jsonrpcEntry?: string;
}

interface PendingRequest {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
}

/** DSH 会话事件通知（params.event）。 */
export interface DshSessionEvent {
	type: string;
	seq: number;
	time: number;
	data: Record<string, unknown>;
}

/**
 * 一个 DSH 运行时子进程。start() 惰性 spawn + initialize 握手；
 * prompt() 按需隐式建会话；kill() 强杀进程树（中止）；restart() 换模型。
 */
export class DshRuntime {
	readonly cwd: string;
	provider: string;
	model: string;
	maxTokens?: number;
	private sessionRoot?: string;
	private dataDir?: string;
	private agentDir?: string;
	private launcher: string;
	/** 额外环境变量（可运行时修改：DSH_PERSONA 等由 launcher env 注入）。 */
	env: Record<string, string | undefined>;
	private jsonrpcEntry: string;

	private proc: ReturnType<typeof spawn> | null = null;
	private startPromise: Promise<void> | null = null;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private notificationHandler: ((method: string, params: unknown) => void) | null = null;
	private stderrTail = "";
	private closed = false;
	private initialized = false;

	/** PI_WEB_DSH_DEBUG=1 时把 RPC 帧/生命周期事件打到 stderr（诊断用，默认关）。 */
	private readonly debugEnabled = process.env.PI_WEB_DSH_DEBUG === "1";
	private debug(...args: unknown[]): void {
		if (this.debugEnabled) console.error("[dsh:client]", ...args);
	}

	/** 进程退出回调（kill/abort 后用于重 spawn 前清理）。
	 *  intentional = 由 kill()/close() 主动触发（反之 = 意外崩溃，供 watchdog 判断）。 */
	onExit: ((code: number | null, signal: string | null, intentional: boolean) => void) | null = null;

	/** 每次成功 initialize 后触发（含初次启动 / 换模型重启 / watchdog 重启）。
	 *  宿主用它重新注册一次性资源（如插件工具桥），因为重 spawn 后 ctx 是全新的。 */
	onStarted: (() => void) | null = null;

	constructor(opts: DshRuntimeOptions) {
		this.cwd = resolve(opts.cwd);
		this.provider = opts.provider ?? "deepseek-official";
		this.model = opts.model ?? "deepseek-v4-flash";
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
					// 回退：相对源码/编译目录向上找项目 node_modules。
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

	/** 运行时子进程是否存活。 */
	get alive(): boolean {
		return !!this.proc && this.proc.exitCode === null;
	}

	get running(): boolean {
		return this.alive;
	}

	/** 启动子进程 + initialize 握手（幂等；并发调用共享同一个启动任务）。 */
	start(): Promise<void> {
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
			throw new DshTransportError(`launcher 不存在: ${this.launcher}`);
		}
		if (!existsSync(this.jsonrpcEntry)) {
			throw new DshTransportError(
				`dsh-sdk-jsonrpc-server 未安装（缺 ${this.jsonrpcEntry}）。请先 npm i @deepseek-ai/dsh-sdk-jsonrpc-server@0.1.1-rc.2`,
			);
		}
		const key = loadDeepSeekKey(this.agentDir);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			DSH_CWD: this.cwd,
			...this.env,
		};
		if (this.sessionRoot) env.DSH_SESSION_ROOT = this.sessionRoot;
		if (this.dataDir) env.PI_WEB_DSH_DATA_DIR = this.dataDir;
		if (key && !this.env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = key;
		env.PI_WEB_DSH_JSONRPC_ENTRY = this.jsonrpcEntry;

		this.closed = false;
		this.buffer = "";
		this.pending.clear();
		this.stderrTail = "";

		this.proc = spawn(process.execPath, [this.launcher], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// POSIX：独立进程组，硬中断时 SIGKILL(-pid) 一次带走运行时 + 它的
			// bash/pwsh 子进程。
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
			this.failPending(new DshTransportError(`runtime 启动失败: ${err.message}`));
		});
		spawned.on("exit", (code, signal) => {
			// 只处理当前 proc 的退出：kill/restart 后旧 proc 迟到的 exit 事件
			// 不得 failPending（否则误伤新 initialize）也不得触发 watchdog。
			if (this.proc !== spawned) return;
			const intentional = this.closed;
			this.debug("exit", { code, signal, intentional });
			const err = new DshTransportError(
				`DSH runtime 已退出 (code=${code} signal=${signal}) stderr: ${this.stderrTail.slice(-400)}`,
			);
			this.failPending(err);
			this.initialized = false;
			this.onExit?.(code, signal, intentional);
		});

		try {
			await this._request("initialize", {
				cwd: this.cwd,
				provider: this.provider,
				model: this.model,
				...(this.maxTokens ? { maxTokens: this.maxTokens } : {}),
			});
		} catch (err) {
			console.error(
				`[dsh] initialize 失败 (model=${this.model} cwd=${this.cwd}): ${(err as Error).message}` +
					(this.stderrTail ? `\n  launcher stderr: ${this.stderrTail.slice(-600)}` : ""),
			);
			// initialize 失败：确认子进程已被清理，避免半死进程占着 stdin。
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
				continue; // 协议：畸形帧忽略
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
				reject(new DshTransportError(`请求 ${method} 超时`));
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
			throw new DshTransportError("runtime 未启动");
		}
		proc.stdin.write(JSON.stringify(msg) + "\n");
	}

	/**
	 * 向一个会话排队 prompt。返回持久化收据 messageId（运行时接受即 resolve）。
	 * 会话不存在时按需隐式创建。
	 */
	async prompt(sessionId: string, contentBlocks: unknown[]): Promise<string> {
		await this.start();
		const res = (await this._request("session/prompt", {
			sessionId,
			contentBlocks,
		})) as { messageId?: unknown };
		if (typeof res.messageId !== "string") {
			throw new DshTransportError("session/prompt 未返回 messageId");
		}
		return res.messageId;
	}

	/** 设置通知处理器（session.event / session.status / subagent.*）。 */
	onNotification(handler: (method: string, params: unknown) => void): void {
		this.notificationHandler = handler;
	}

	// -----------------------------------------------------------------------
	// goal RPC（goal-rpc.mjs wrapper 插件直连 DSH 原生 goal 域）
	// -----------------------------------------------------------------------

	/** 创建（或替换已完成的）目标并 arm；round-driver 自动续轮。返回原生 view。 */
	async goalSet(sessionId: string, objective: string, maxGoalRounds?: number): Promise<unknown> {
		await this.start();
		return this._request("goal/set", {
			sessionId,
			objective,
			...(maxGoalRounds && maxGoalRounds > 0 ? { maxGoalRounds } : {}),
		});
	}

	/** 当前目标视图（{goal|null, activation}）。 */
	async goalGet(sessionId: string): Promise<unknown> {
		await this.start();
		return this._request("goal/get", { sessionId });
	}

	/** 清除当前目标（保留 durable 墓碑与历史）。 */
	async goalClear(sessionId: string): Promise<unknown> {
		await this.start();
		return this._request("goal/clear", { sessionId });
	}

	/** 恢复被 disarm 的目标（abort 重启运行时后轮次驱动停止）。 */
	async goalResume(sessionId: string): Promise<unknown> {
		await this.start();
		return this._request("goal/resume", { sessionId });
	}

	/** P2-17 查询运行时模型目录（adapter 真实清单，含 inputModalities）。 */
	async listModels(
		provider = "deepseek-official",
	): Promise<{ models: { id: string; name?: string; inputModalities?: string[] }[]; error?: string }> {
		await this.start();
		return this._request("model/list", { provider }) as Promise<{
			models: { id: string; name?: string; inputModalities?: string[] }[];
			error?: string;
		}>;
	}

	// -----------------------------------------------------------------------
	// 附件 RPC（视觉桥）：base64 图片 ↔ durable ImageAttachmentRef
	// -----------------------------------------------------------------------

	/** 保存 base64 图片 → ImageAttachmentRef（供 prompt 的 image 块引用）。 */
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

	/** 按 ref 回读图片字节（base64），回放时补全前端显示。 */
	async attachmentRead(ref: { attachmentId: string; mediaType: string }): Promise<{ mediaType: string; data: string }> {
		await this.start();
		return this._request("attachment/read", { ref }) as Promise<{ mediaType: string; data: string }>;
	}

	/** 回答模型提问（question.pending 通知的 id）。cancelled = 用户取消。 */
	async answerQuestion(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
	): Promise<unknown> {
		await this.start();
		return this._request("question/answer", { id, answers, ...(cancelled ? { cancelled: true } : {}) });
	}

	// -----------------------------------------------------------------------
	// 工具桥 RPC（#15 插件注入点）：sync 注册插件工具 / list 校验 / call-result 回传
	// -----------------------------------------------------------------------

	/** 把一批插件工具（name/description/parameters）注册为 DSH 原生工具。返回注册清单。 */
	async syncTools(
		tools: { name: string; description: string; parameters?: Record<string, unknown> }[],
	): Promise<{ registered: string[]; count: number }> {
		await this.start();
		return this._request("tools/sync", { tools }) as Promise<{ registered: string[]; count: number }>;
	}

	/** 列出运行时当前可见的工具 schema（零 key 校验/调试用）。 */
	async listTools(): Promise<{ tools: { name: string; description: string; parameters?: unknown }[] }> {
		await this.start();
		return this._request("tools/list", {}) as Promise<{
			tools: { name: string; description: string; parameters?: unknown }[];
		}>;
	}

	/** 回传一个桥接工具的执行结果（isError=true 时 result 为错误信息）。 */
	async toolsCallResult(id: string, result: string, isError?: boolean): Promise<unknown> {
		await this.start();
		return this._request("tools/call-result", { id, result, ...(isError ? { isError: true } : {}) });
	}

	/** 调试/probe 用：触发一个桥接工具的完整往返（需运行时 PI_WEB_DSH_DEBUG=1）。 */
	async invokeTool(
		name: string,
		args?: Record<string, unknown>,
	): Promise<{ ok: boolean; value?: unknown; error?: string }> {
		await this.start();
		return this._request("tools/invoke", { name, args }) as Promise<{ ok: boolean; value?: unknown; error?: string }>;
	}

	// -----------------------------------------------------------------------
	// 技能 RPC（#18 技能启停 UI）：skills/list + skills/set-disabled
	// -----------------------------------------------------------------------

	/** 列出运行时当前可见技能（SkillRegistry.list）。 */
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

	/** 设置禁用技能集合（供晚 pre-step 钩子过滤 skill-catalog 消息）。 */
	async setDisabledSkills(skills: string[]): Promise<{ disabled: string[] }> {
		await this.start();
		return this._request("skills/set-disabled", { skills }) as Promise<{ disabled: string[] }>;
	}

	/** 优雅关闭：shutdown 握手 → stdin EOF → SIGTERM → SIGKILL 阶梯。 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) {
			this.proc = null;
			return;
		}
		try {
			await this._request("shutdown", {}, 2000);
		} catch {
			/* fall through to kill ladder */
		}
		try {
			proc.stdin!.end();
		} catch {
			/* ignore */
		}
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
			} catch {
				/* ignore */
			}
			await this._waitExit(proc, 1500);
		}
		if (proc.exitCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
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

	/**
	 * 强杀运行时子进程 + 整棵进程树，无 shutdown 握手（硬中止）。
	 * win32: taskkill /pid X /T /F；posix: SIGKILL(-pid)（detached 进程组）。
	 */
	async kill(): Promise<void> {
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
		this.failPending(new DshTransportError("runtime killed (interrupt)"));
		try {
			if (process.platform === "win32") {
				const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
					stdio: "ignore",
					windowsHide: true,
				});
				killer.on("error", () => {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* already dead */
					}
				});
			} else {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* already dead */
					}
				}
			}
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}
	}

	/** 换模型：关掉当前运行时（若活着），下次 start() 用新 model 重新 spawn。 */
	async restart(newModel?: string, newProvider?: string): Promise<void> {
		const wasAlive = this.alive;
		this.debug("restart", { newModel, newProvider, wasAlive });
		if (wasAlive) {
			await this.kill();
			// 等旧进程真正退出（避免 pid 复用竞态）。
			await new Promise((r) => setTimeout(r, 150));
		}
		if (newModel) this.model = newModel;
		if (newProvider) this.provider = newProvider;
		this.initialized = false;
		if (wasAlive) await this.start();
	}

	/** stderr 尾部（诊断用）。 */
	get stderr(): string {
		return this.stderrTail;
	}
}
