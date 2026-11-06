import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeEngineCliVersion, resolveEngineCliLaunch } from "../../engine-cli.js";
import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink, type AgentTurnMeta } from "../driver-base.js";
import type { PromptAttachment, SlashCommandInfo } from "../../protocol.js";
import {
	resolveProviderCredential,
	listCustomModelsFromConfig,
	isModelProtocolSupportedByEngine,
} from "../../model-resolver.js";
import { discoverDiskSkills } from "../../skill-discovery.js";
import { formatUnavailableCanvasReference } from "../universal-attachments.js";

export interface ClaudeCodeDriverOptions {
	executablePath?: string;
	extraArgs?: string[];
	defaultModel?: string;
	agentDir?: string;
}

export async function probeClaudeCode(executablePath?: string): Promise<{
	installed: boolean;
	version?: string;
	error?: string;
}> {
	const { available, ...result } = await probeEngineCliVersion("claude", executablePath);
	return { installed: available, ...result };
}

export class ClaudeCodeDriver extends BaseAgentDriver {
	readonly id = "claude-code";
	readonly name = "Claude Code";
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: false,
		supportsHistoryEdit: false,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: true,
		supportsAskUser: false,
	};

	private readonly executablePath: string | undefined;
	private readonly extraArgs: string[];
	private readonly agentDir: string;
	private currentModel: string;
	private activeSessionId: string | null = null;
	private activeProcess: ChildProcess | null = null;
	private aborted = false;
	private turnSeq = 0;
	private lastErrorHint = "";
	private turnHadText = false;
	private turnCompleteEmitted = false;
	private lastTurnMeta?: AgentTurnMeta;
	private currentThinkingLevel: string = "medium";
	private readonly seenToolStarts = new Set<string>();
	private readonly seenToolEnds = new Set<string>();

	constructor(cwd: string, opts?: ClaudeCodeDriverOptions) {
		super(cwd);
		this.executablePath = opts?.executablePath;
		this.extraArgs = opts?.extraArgs ?? ["--dangerously-skip-permissions"];
		this.currentModel = opts?.defaultModel ?? "claude-3-7-sonnet-20250219";
		this.agentDir = opts?.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	}

	async createSession(): Promise<string> {
		this.activeSessionId = null;
		return `claude-sess-${Date.now()}`;
	}

	async resumeSession(sessionId: string): Promise<void> {
		this.activeSessionId = sessionId;
	}

	getActiveSessionId(): string | null {
		return this.activeSessionId;
	}

	override setThinkingLevel(level: string): void {
		this.currentThinkingLevel = level;
	}

	override getSupportedThinkingLevels(): string[] {
		return ["off", "low", "medium", "high", "xhigh", "max"];
	}

	async sendPrompt(prompt: string, attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void> {
		const mySeq = ++this.turnSeq;
		this.aborted = false;
		this.lastErrorHint = "";
		this.turnHadText = false;
		this.turnCompleteEmitted = false;
		this.seenToolStarts.clear();
		this.seenToolEnds.clear();

		let finalPrompt = prompt;
		if (attachments && attachments.length > 0) {
			const notes: string[] = [];
			for (const att of attachments) {
				if (att.mode === "canvas") {
					notes.push(formatUnavailableCanvasReference(att));
					continue;
				}
				if (att.path) {
					const lineRange = att.lines ? ` (行 ${att.lines.start}-${att.lines.end})` : "";
					notes.push(`[文件引用: ${att.path}${lineRange}]`);
				} else if (att.uploadPath) {
					notes.push(`[上传文件: ${att.name || att.uploadPath}]`);
				} else if (att.imageData) {
					notes.push(`[包含图片附件: ${att.name || "图片"}]`);
				} else if (att.quote?.text) {
					notes.push(`[引用内容: "${att.quote.text.slice(0, 100)}..."]`);
				}
			}
			if (notes.length > 0) {
				finalPrompt = `${notes.join("\n")}\n\n${prompt}`;
			}
		}

		const args = ["-p", "--output-format", "stream-json", "--verbose", ...this.extraArgs];

		let targetModel = this.currentModel;
		let targetProvider: string | null = null;
		let isOfficial = false;

		if (this.currentModel.includes("/")) {
			const parts = this.currentModel.split("/");
			if (parts[0] === "claude-code") {
				isOfficial = true;
				targetModel = parts.slice(1).join("/");
			} else {
				targetProvider = parts[0];
				targetModel = parts.slice(1).join("/");
			}
		} else {
			isOfficial = true;
		}

		if (targetModel) {
			args.push("--model", targetModel);
		}

		if (this.currentThinkingLevel && this.currentThinkingLevel !== "off") {
			args.push("--effort", this.currentThinkingLevel);
		}

		if (this.activeSessionId) {
			args.push("--resume", this.activeSessionId);
		}

		const spawnEnv = this.buildSpawnEnv(isOfficial, targetProvider);

		let proc: ChildProcess;
		try {
			const launch = resolveEngineCliLaunch("claude", { executablePath: this.executablePath, cwd: this.cwd });
			proc = spawn(launch.file, [...launch.args, ...args], {
				cwd: this.cwd,
				env: spawnEnv,
				detached: process.platform !== "win32",
			});
			if (proc.stdin) {
				proc.stdin.write(finalPrompt);
				proc.stdin.end();
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			sink.onError(
				`无法启动 Claude Code CLI: ${msg}。请确保已全局安装 npm i -g @anthropic-ai/claude-code 且已在终端运行 claude 完成登录。`,
			);
			return;
		}

		this.activeProcess = proc;

		const activeToolJson = new Map<string, string>();

		if (proc.stdout) {
			const rl = createInterface({ input: proc.stdout, terminal: false });

			rl.on("line", (line: string) => {
				if (mySeq !== this.turnSeq) return;
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith("{")) return;

				try {
					const event = JSON.parse(trimmed) as Record<string, unknown>;
					this.handleClaudeEvent(event, sink, activeToolJson);
				} catch {}
			});
		}

		let stderrOutput = "";
		if (proc.stderr) {
			proc.stderr.on("data", (chunk: Buffer) => {
				stderrOutput += chunk.toString("utf-8");
			});
		}

		return new Promise<void>((resolve) => {
			proc.on("error", (err: Error) => {
				if (mySeq !== this.turnSeq) {
					resolve();
					return;
				}
				if (this.activeProcess === proc) this.activeProcess = null;
				if (!this.aborted) {
					sink.onError(`Claude Code 进程启动失败: ${err.message}`);
				}
				resolve();
			});

			proc.on("close", (code: number | null) => {
				if (mySeq !== this.turnSeq) {
					resolve();
					return;
				}
				if (this.activeProcess === proc) this.activeProcess = null;
				if (this.aborted) {
					resolve();
					return;
				}

				if (code !== 0 && code !== null) {
					const errHint = this.lastErrorHint || stderrOutput.trim() || `Exit code ${code}`;
					sink.onError(`Claude Code 执行退出 (code ${code}): ${errHint}`);
				} else if (!this.turnCompleteEmitted) {
					const meta: AgentTurnMeta = { model: this.currentModel };
					this.lastTurnMeta = meta;
					sink.onTurnComplete(meta);
				}
				resolve();
			});
		});
	}

	private handleClaudeEvent(
		event: Record<string, unknown>,
		sink: AgentEventSink,
		activeToolJson: Map<string, string>,
	): void {
		if (event.type === "stream_event" && event.event && typeof event.event === "object") {
			this.handleClaudeEvent(event.event as Record<string, unknown>, sink, activeToolJson);
			return;
		}

		const type = String(event.type ?? "");

		if (type === "system" && typeof event.session_id === "string") {
			this.activeSessionId = event.session_id;
		}

		if (type === "assistant") {
			const msg = event.message as Record<string, unknown> | undefined;
			if (msg && Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (item && typeof item === "object") {
						const block = item as Record<string, unknown>;
						if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
							sink.onThinkingDelta(block.thinking);
						} else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
							sink.onTextDelta(block.text);
							this.turnHadText = true;
						} else if (block.type === "tool_use") {
							const callId = String(block.id ?? `tool_${Date.now()}`);
							if (!this.seenToolStarts.has(callId)) {
								this.seenToolStarts.add(callId);
								const toolName = String(block.name ?? "tool");
								const input = (block.input as Record<string, unknown>) ?? {};
								sink.onToolStart(callId, toolName, input);
							}
						}
					}
				}
			}
			if (event.error) {
				const errMsg = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
				this.lastErrorHint = errMsg;
			}
		}

		if (type === "user") {
			const msg = event.message as Record<string, unknown> | undefined;
			if (msg && Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (item && typeof item === "object") {
						const block = item as Record<string, unknown>;
						if (block.type === "tool_result") {
							const toolId = String(block.tool_use_id ?? block.id ?? "");
							if (toolId && !this.seenToolEnds.has(toolId)) {
								this.seenToolEnds.add(toolId);
								const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
								const isError = Boolean(block.is_error);
								sink.onToolEnd(toolId, isError ? { error: content } : { output: content });
							}
						}
					}
				}
			}
		}

		if (type === "content_block_delta") {
			const delta = event.delta as Record<string, unknown> | undefined;
			if (!delta) return;

			if (delta.type === "text_delta" && typeof delta.text === "string") {
				sink.onTextDelta(delta.text);
				this.turnHadText = true;
			} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
				sink.onThinkingDelta(delta.thinking);
			} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
				const index = String(event.index ?? 0);
				activeToolJson.set(index, (activeToolJson.get(index) ?? "") + delta.partial_json);
			}
		}

		if (type === "content_block_start") {
			const block = event.content_block as Record<string, unknown> | undefined;
			if (block && block.type === "tool_use") {
				const callId = String(block.id ?? `tool_${Date.now()}`);
				if (!this.seenToolStarts.has(callId)) {
					this.seenToolStarts.add(callId);
					const toolName = String(block.name ?? "tool");
					const input = (block.input as Record<string, unknown>) ?? {};
					sink.onToolStart(callId, toolName, input);
				}
			}
		}

		if (type === "tool_use") {
			const callId = String(event.id ?? `tool_${Date.now()}`);
			if (!this.seenToolStarts.has(callId)) {
				this.seenToolStarts.add(callId);
				const toolName = String(event.name ?? "tool");
				const input = (event.input as Record<string, unknown>) ?? {};
				sink.onToolStart(callId, toolName, input);
			}
		}

		if (type === "tool_result") {
			const toolId = String(event.tool_use_id ?? event.id ?? "");
			if (toolId && !this.seenToolEnds.has(toolId)) {
				this.seenToolEnds.add(toolId);
				const content = typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? "");
				const isError = Boolean(event.is_error);
				sink.onToolEnd(toolId, isError ? { error: content } : { output: content });
			}
		}

		if (type === "result") {
			if (event.is_error && event.result) {
				const resStr = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
				this.lastErrorHint = resStr;
			} else if (!this.turnHadText && typeof event.result === "string" && event.result.trim()) {
				sink.onTextDelta(event.result.trim());
				this.turnHadText = true;
			}
			const usage = event.usage as Record<string, number> | undefined;
			const costUSD = typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined;
			const inputTokens = usage?.input_tokens ?? 0;
			const outputTokens = usage?.output_tokens ?? 0;
			const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
			const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
			this.turnCompleteEmitted = true;
			const turnMeta: AgentTurnMeta = {
				usage: usage
					? {
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							costUSD,
						}
					: undefined,
				costUSD,
				contextTokens: inputTokens > 0 ? inputTokens + outputTokens : undefined,
				model: typeof event.model === "string" ? event.model : this.currentModel,
			};
			this.lastTurnMeta = turnMeta;
			sink.onTurnComplete(turnMeta);
		}
	}

	buildSpawnEnv(isOfficial: boolean, targetProvider: string | null): NodeJS.ProcessEnv {
		const spawnEnv: NodeJS.ProcessEnv = {
			...process.env,
			NO_COLOR: "1",
		};

		if (!isOfficial && targetProvider) {
			const cred = this.agentDir
				? resolveProviderCredential(this.agentDir, targetProvider)
				: { providerId: targetProvider };

			if (cred.baseUrl) {
				spawnEnv.ANTHROPIC_BASE_URL = cred.baseUrl;
			}
			if (cred.apiKey) {
				spawnEnv.ANTHROPIC_API_KEY = cred.apiKey;
			}
			if (cred.headers) {
				for (const [hk, hv] of Object.entries(cred.headers)) {
					if (hk.toLowerCase() === "authorization" && hv) {
						spawnEnv.ANTHROPIC_AUTH_TOKEN = hv.replace(/^Bearer\s+/i, "");
					}
				}
			}
		}

		return spawnEnv;
	}

	async abort(): Promise<void> {
		this.turnSeq++;
		this.aborted = true;
		if (this.activeProcess) {
			try {
				if (process.platform === "win32") {
					spawn("taskkill", ["/pid", String(this.activeProcess.pid), "/t", "/f"]);
				} else {
					try {
						process.kill(-this.activeProcess.pid!, "SIGINT");
					} catch {
						this.activeProcess.kill("SIGINT");
					}
				}
			} catch {}
			this.activeProcess = null;
		}
	}

	async listModels(): Promise<Array<{ id: string; name: string }>> {
		const official = [
			{ id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet" },
			{ id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
			{ id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
			{ id: "claude-3-opus-20240229", name: "Claude 3 Opus" },
		];

		if (!this.agentDir) return official;

		const custom = listCustomModelsFromConfig(this.agentDir, (entry) =>
			isModelProtocolSupportedByEngine("claude", entry),
		);
		const customRows = custom.map((c) => ({
			id: `${c.providerId}/${c.modelId}`,
			name: c.name,
		}));

		return [...official, ...customRows];
	}

	async setModel(modelId: string): Promise<void> {
		this.currentModel = modelId;
	}

	override async getSlashCommands(): Promise<SlashCommandInfo[]> {
		return [
			{
				name: "cost",
				description: "查看 Claude Code 累计 Token 与成本消耗",
				descriptionEn: "Show Claude Code cumulative tokens & cost",
				source: "extension",
			},
			{
				name: "doctor",
				description: "运行 Claude Code 环境与凭据健康诊断",
				descriptionEn: "Run Claude Code environment & auth diagnostics",
				source: "extension",
			},
			{
				name: "init",
				description: "在当前工作区初始化 CLAUDE.md 指引文件",
				descriptionEn: "Initialize CLAUDE.md guidelines in workspace",
				source: "extension",
			},
			{
				name: "clear",
				description: "重置 Claude Code 会话上下文（相当于 /clear）",
				descriptionEn: "Reset Claude Code session context",
				source: "extension",
			},
		];
	}

	override async execSlashCommand(
		name: string,
		_args: string,
		context?: {
			emitNotice?: (level: "info" | "warning" | "error", text: string, textEn?: string) => void;
			sink?: AgentEventSink;
		},
	): Promise<boolean> {
		switch (name) {
			case "cost": {
				const meta = this.lastTurnMeta;
				const usage = meta?.usage;
				const cost = meta?.costUSD ?? usage?.costUSD ?? 0;
				const text = usage
					? `Claude Code 用量：输入 ${usage.inputTokens ?? 0} tokens · 输出 ${usage.outputTokens ?? 0} tokens · 费用 $${cost.toFixed(4)}`
					: `Claude Code 当前未记录上一轮 token 用量`;
				const textEn = usage
					? `Claude Code usage: in ${usage.inputTokens ?? 0} tok · out ${usage.outputTokens ?? 0} tok · cost $${cost.toFixed(4)}`
					: `No turn token usage recorded yet`;
				context?.emitNotice?.("info", text, textEn);
				return true;
			}
			case "doctor": {
				const probe = await probeClaudeCode(this.executablePath);
				const status = probe.installed
					? `Claude Code CLI 正常 (版本: ${probe.version ?? "已安装"}) · Node ${process.version}`
					: `未检测到 Claude Code CLI: ${probe.error ?? "请运行 npm i -g @anthropic-ai/claude-code"}`;
				const statusEn = probe.installed
					? `Claude Code CLI OK (v${probe.version ?? "installed"}) · Node ${process.version}`
					: `Claude Code CLI not found: ${probe.error ?? "run npm i -g @anthropic-ai/claude-code"}`;
				context?.emitNotice?.(probe.installed ? "info" : "warning", status, statusEn);
				return true;
			}
			case "init": {
				const target = join(this.cwd, "CLAUDE.md");
				if (existsSync(target)) {
					context?.emitNotice?.("info", "CLAUDE.md 已存在于当前工作区", "CLAUDE.md already exists in workspace");
				} else {
					try {
						const template = `# CLAUDE.md\n\n> Project guidelines for Claude Code\n\n## Build & Test\n- Build: npm run build\n- Test: npm test\n`;
						writeFileSync(target, template, "utf8");
						context?.emitNotice?.("info", "已在当前工作区创建初始 CLAUDE.md", "Created initial CLAUDE.md in workspace");
					} catch (err) {
						context?.emitNotice?.(
							"error",
							`创建 CLAUDE.md 失败: ${(err as Error).message}`,
							`Failed to create CLAUDE.md: ${(err as Error).message}`,
						);
					}
				}
				return true;
			}
			case "clear": {
				this.activeSessionId = null;
				context?.emitNotice?.("info", "Claude Code 驱动会话上下文已重置", "Claude Code session context reset");
				return true;
			}
			default:
				return false;
		}
	}

	override async getSkills(): Promise<Array<{ name: string; description: string; filePath?: string }>> {
		const skills = discoverDiskSkills({ cwd: this.cwd, agentDir: this.agentDir });
		return skills.map((s) => ({
			name: s.name,
			description: s.description,
			filePath: s.filePath,
		}));
	}

	dispose(): void {
		void this.abort();
	}
}
