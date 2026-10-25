/**
 * claude-code.ts — Anthropic Claude Code CLI 驱动实现。
 *
 * 通过子进程拉起官方 `claude` CLI（--output-format stream-json），
 * 实时将 Claude Code 输出的 NDJSON 事件流映射为 Universal 底座的 AgentEventSink 事件。
 *
 * 特性：
 *   1. 原生支持流式正文输出与 Thinking 思考过程；
 *   2. 自动捕获 Bash / View / Edit / Glob / Grep 等工具调用并折叠展示；
 *   3. 会话自动维护：每次对话通过 --resume <sessionId> 保持上下文连续；
 *   4. 支持用户中断（abort）时向进程发送中断信号；
 *   5. 环境容错：未安装 claude 时输出清晰友好的中英文引导提示。
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink, type AgentTurnMeta } from "../driver-base.js";
import type { PromptAttachment, SlashCommandInfo } from "../../protocol.js";
import {
	resolveProviderCredential,
	listCustomModelsFromConfig,
	isModelProtocolSupportedByEngine,
} from "../../model-resolver.js";
import { discoverDiskSkills } from "../../skill-discovery.js";

export interface ClaudeCodeDriverOptions {
	/** 自定义 claude 执行命令路径（默认 "claude"） */
	executablePath?: string;
	/** 额外传递给 claude CLI 的参数，如 ["--dangerously-skip-permissions"] */
	extraArgs?: string[];
	/** 默认使用的 Claude 模型，如 "claude-3-7-sonnet-20250219" */
	defaultModel?: string;
	/** Pi 智能体配置目录，用于读取 models.json、auth.json 与多密钥配置 */
	agentDir?: string;
}

/**
 * 快速异步探测系统中是否安装了可用的 Claude Code CLI。
 */
export async function probeClaudeCode(executablePath = "claude"): Promise<{
	installed: boolean;
	version?: string;
	error?: string;
}> {
	return new Promise((resolve) => {
		try {
			execFile(
				executablePath,
				["--version"],
				{
					timeout: 4000,
					shell: process.platform === "win32",
				},
				(err, stdout) => {
					if (err) {
						resolve({ installed: false, error: err.message });
					} else {
						const v = stdout.trim();
						resolve({ installed: true, version: v || undefined });
					}
				},
			);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			resolve({ installed: false, error: msg });
		}
	});
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

	private readonly executablePath: string;
	private readonly extraArgs: string[];
	private readonly agentDir: string;
	private currentModel: string;
	private activeSessionId: string | null = null;
	private activeProcess: ChildProcess | null = null;
	private aborted = false;
	/** 单槽回合代际（#702）：abort/新回合 +1；在途旧进程的迟到事件（close/stdout）一律按过期丢弃，
	 *  不再清空新回合的 activeProcess、不再向旧 sink 误发输出。 */
	private turnSeq = 0;
	private lastErrorHint = "";
	private turnHadText = false;
	private turnCompleteEmitted = false;
	private lastTurnMeta?: AgentTurnMeta;
	private currentThinkingLevel: string = "medium";

	constructor(cwd: string, opts?: ClaudeCodeDriverOptions) {
		super(cwd);
		this.executablePath = opts?.executablePath ?? "claude";
		// 默认添加 --dangerously-skip-permissions，防止无头模式下因等待交互式 y/n 确认导致整个生成假死
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

		// 格式化用户附件上下文
		let finalPrompt = prompt;
		if (attachments && attachments.length > 0) {
			const notes: string[] = [];
			for (const att of attachments) {
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

		// 提示词通过 stdin 管道写入，argv 仅保留参数选项：
		// 1. 规避 Windows 下 shell: true 拼接命令行导致的注入与 DEP0190 警告；
		// 2. 杜绝 Windows cmd.exe 遇换行 (\n) 截断丢弃后续多行 prompt 的严重缺陷；
		// 3. 避免单次 prompt 超出 Windows 命令行 8191 字符上限。
		const args = ["-p", "--output-format", "stream-json", "--verbose", ...this.extraArgs];

		// 解析目标模型与对应服务商凭据
		let targetModel = this.currentModel;
		let targetProvider = "anthropic";
		if (this.currentModel.includes("/")) {
			const parts = this.currentModel.split("/");
			if (parts[0] === "claude-code") {
				targetProvider = "anthropic";
				targetModel = parts.slice(1).join("/");
			} else {
				targetProvider = parts[0];
				targetModel = parts.slice(1).join("/");
			}
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

		// 动态从模型配置基础层解析凭据与 BaseURL，实现类似 cc-switch 的零侵入环境注入
		const cred = this.agentDir
			? resolveProviderCredential(this.agentDir, targetProvider)
			: { providerId: targetProvider };

		const spawnEnv: NodeJS.ProcessEnv = {
			...process.env,
			NO_COLOR: "1",
			CI: "1",
		};

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

		let proc: ChildProcess;
		try {
			proc = spawn(this.executablePath, args, {
				cwd: this.cwd,
				env: spawnEnv,
				// Windows 下处理 .cmd 包装脚本；Unix 下 detached 方便向进程组发送 SIGINT
				shell: process.platform === "win32",
				detached: process.platform !== "win32",
			});
			// 经 stdin 写入 prompt 并关闭管道，CLI 读完后流式处理
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
				} catch {
					// 忽略非 JSON 行日志
				}
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
		const type = String(event.type ?? "");

		// 1. 会话建立或恢复事件
		if (type === "system" && typeof event.session_id === "string") {
			this.activeSessionId = event.session_id;
		}

		// 1.1 assistant 完整消息（含思考、正文、错误或合成响应）
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
						}
					}
				}
			}
			if (event.error) {
				const errMsg = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
				this.lastErrorHint = errMsg;
			}
		}

		// 2. 流式 Content Block 增量
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

		// 3. 工具调用开始 (content_block_start)
		if (type === "content_block_start") {
			const block = event.content_block as Record<string, unknown> | undefined;
			if (block && block.type === "tool_use") {
				const callId = String(block.id ?? `tool_${Date.now()}`);
				const toolName = String(block.name ?? "tool");
				const input = (block.input as Record<string, unknown>) ?? {};
				sink.onToolStart(callId, toolName, input);
			}
		}

		// 4. 工具调用直接触发 (完整块)
		if (type === "tool_use") {
			const callId = String(event.id ?? `tool_${Date.now()}`);
			const toolName = String(event.name ?? "tool");
			const input = (event.input as Record<string, unknown>) ?? {};
			sink.onToolStart(callId, toolName, input);
		}

		// 5. 工具执行结果
		if (type === "tool_result") {
			const toolId = String(event.tool_use_id ?? event.id ?? "");
			const content = typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? "");
			const isError = Boolean(event.is_error);
			sink.onToolEnd(toolId, isError ? { error: content } : { output: content });
		}

		// 6. 最终完成统计
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

	async abort(): Promise<void> {
		this.turnSeq++;
		this.aborted = true;
		if (this.activeProcess) {
			try {
				if (process.platform === "win32") {
					// Windows 上 spawn 带有 shell 时通过 taskkill /t /f 终止整棵进程树
					spawn("taskkill", ["/pid", String(this.activeProcess.pid), "/t", "/f"]);
				} else {
					try {
						process.kill(-this.activeProcess.pid!, "SIGINT");
					} catch {
						this.activeProcess.kill("SIGINT");
					}
				}
			} catch {
				/* best effort */
			}
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

		// 仅继承 Claude / Anthropic 兼容协议的模型，过滤纯 OpenAI / Google 协议
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
