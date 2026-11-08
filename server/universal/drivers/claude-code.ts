import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
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
import { decodeInlineImage, describeCliAttachment } from "../universal-attachments.js";
import { collectEnabledMcpServers, toClaudeMcpConfig } from "../engine-mcp.js";

export interface ClaudeCodeDriverOptions {
	executablePath?: string;
	extraArgs?: string[];
	defaultModel?: string;
	agentDir?: string;
	dataDir?: string;
}

/** `default` = no `--model`, so the CLI follows the user's own Claude Code configuration. */
export const CLAUDE_CODE_MODELS: ReadonlyArray<{ id: string; name: string }> = [
	{ id: "default", name: "Default (Claude Code config)" },
	{ id: "opus", name: "Opus (latest)" },
	{ id: "sonnet", name: "Sonnet (latest)" },
	{ id: "haiku", name: "Haiku (latest)" },
];

/** Older builds defaulted to retired Claude 3.x ids; those now fail every turn, so map them to `default`. */
export function normalizeClaudeModelId(modelId: string): string {
	const prefixed = modelId.startsWith("claude-code/");
	const bare = prefixed ? modelId.slice("claude-code/".length) : modelId;
	if (!bare.startsWith("claude-3-")) return modelId;
	return prefixed ? "claude-code/default" : "default";
}

/** pi-web-ui commands that drive UI state and must not be forwarded to the CLI. */
const PI_OWNED_SLASH = new Set([
	"new",
	"name",
	"model",
	"cwd",
	"plan",
	"thinking",
	"resume",
	"reload",
	"help",
	"copy",
	"subagent",
	"pi-web-ui:quit",
]);

/** Claude API per-image limit; larger images are passed as files the CLI reads itself. */
const CLAUDE_MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export async function probeClaudeCode(executablePath?: string): Promise<{
	installed: boolean;
	version?: string;
	error?: string;
}> {
	const { available, ...result } = await probeEngineCliVersion("claude", executablePath);
	return { installed: available, ...result };
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (block && typeof block === "object") {
					const b = block as Record<string, unknown>;
					if (b.type === "text" && typeof b.text === "string") return b.text;
					if (b.type === "image") return "[image]";
				}
				return JSON.stringify(block);
			})
			.join("\n");
	}
	return JSON.stringify(content ?? "");
}

export class ClaudeCodeDriver extends BaseAgentDriver {
	readonly id = "claude-code";
	readonly name = "Claude Code";
	readonly maxInlineImageBytes = CLAUDE_MAX_INLINE_IMAGE_BYTES;
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
	private readonly dataDir: string | undefined;
	private currentModel: string;
	private activeSessionId: string | null = null;
	private activeProcess: ChildProcess | null = null;
	private aborted = false;
	private turnSeq = 0;
	private lastErrorHint = "";
	private turnHadText = false;
	private turnCompleteEmitted = false;
	private resultFailed = false;
	private currentThinkingLevel: string = "medium";
	private readonly seenToolStarts = new Set<string>();
	private readonly seenToolEnds = new Set<string>();
	private nativeSlashCommands: string[] = [];
	private nativeSkills = new Set<string>();
	private slashCommandsChanged = false;

	constructor(cwd: string, opts?: ClaudeCodeDriverOptions) {
		super(cwd);
		this.executablePath = opts?.executablePath;
		this.extraArgs = opts?.extraArgs ?? ["--dangerously-skip-permissions"];
		this.currentModel = normalizeClaudeModelId(opts?.defaultModel ?? "default");
		this.agentDir = opts?.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
		this.dataDir = opts?.dataDir;
	}

	async createSession(): Promise<string> {
		// The real id is only known once the CLI reports it (system/init); never hand out a placeholder
		// that a later `--resume` would reject.
		this.activeSessionId = null;
		return "";
	}

	async resumeSession(sessionId: string): Promise<void> {
		this.activeSessionId = sessionId || null;
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

	/** Builds the stream-json user message: inline images + text (attachment pointers, then the prompt). */
	buildUserMessage(prompt: string, attachments: PromptAttachment[] | undefined): Record<string, unknown> {
		const content: Array<Record<string, unknown>> = [];
		const notes: string[] = [];
		for (const att of attachments ?? []) {
			const image = decodeInlineImage(att);
			if (image) {
				content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
				continue;
			}
			const note = describeCliAttachment(att);
			if (note) notes.push(note);
		}
		content.push({ type: "text", text: notes.length ? `${notes.join("\n")}\n\n${prompt}` : prompt });
		return { type: "user", message: { role: "user", content } };
	}

	async sendPrompt(prompt: string, attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void> {
		const mySeq = ++this.turnSeq;
		this.aborted = false;
		this.lastErrorHint = "";
		this.turnHadText = false;
		this.turnCompleteEmitted = false;
		this.resultFailed = false;
		this.seenToolStarts.clear();
		this.seenToolEnds.clear();

		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			...this.extraArgs,
		];

		let targetModel = this.currentModel;
		let targetProvider: string | null = null;
		let isOfficial = true;
		if (this.currentModel.includes("/")) {
			const slash = this.currentModel.indexOf("/");
			const provider = this.currentModel.slice(0, slash);
			targetModel = this.currentModel.slice(slash + 1);
			if (provider !== "claude-code") {
				isOfficial = false;
				targetProvider = provider;
			}
		}
		if (targetModel && targetModel !== "default") {
			args.push("--model", targetModel);
		}

		if (this.currentThinkingLevel && this.currentThinkingLevel !== "off") {
			args.push("--effort", this.currentThinkingLevel);
		}

		if (this.activeSessionId) {
			args.push("--resume", this.activeSessionId);
		}

		let mcpDir: string | undefined;
		const cleanup = () => {
			if (mcpDir) rmSync(mcpDir, { recursive: true, force: true });
			mcpDir = undefined;
		};

		let proc: ChildProcess;
		try {
			const servers = collectEnabledMcpServers({ cwd: this.cwd, agentDir: this.agentDir, dataDir: this.dataDir });
			if (Object.keys(servers).length > 0) {
				// File (not an inline JSON arg) so env/headers secrets don't show up in the process list.
				mcpDir = mkdtempSync(join(tmpdir(), "pi-claude-mcp-"));
				const mcpFile = join(mcpDir, "mcp.json");
				writeFileSync(mcpFile, JSON.stringify(toClaudeMcpConfig(servers)), { mode: 0o600 });
				args.push("--mcp-config", mcpFile);
			}
			const userMessage = this.buildUserMessage(prompt, attachments);
			const launch = resolveEngineCliLaunch("claude", { executablePath: this.executablePath, cwd: this.cwd });
			proc = spawn(launch.file, [...launch.args, ...args], {
				cwd: this.cwd,
				env: this.buildSpawnEnv(isOfficial, targetProvider),
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			if (proc.stdin) {
				proc.stdin.on("error", () => {});
				proc.stdin.end(`${JSON.stringify(userMessage)}\n`);
			}
		} catch (err: unknown) {
			cleanup();
			const msg = err instanceof Error ? err.message : String(err);
			sink.onError(
				`无法启动 Claude Code CLI: ${msg}。请确保已全局安装 npm i -g @anthropic-ai/claude-code 且已在终端运行 claude 完成登录。`,
			);
			return;
		}

		this.activeProcess = proc;

		if (proc.stdout) {
			const rl = createInterface({ input: proc.stdout, terminal: false });
			rl.on("line", (line: string) => {
				if (mySeq !== this.turnSeq) return;
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith("{")) return;
				try {
					const event = JSON.parse(trimmed) as Record<string, unknown>;
					this.handleClaudeEvent(event, sink);
				} catch {}
			});
		}

		let stderrOutput = "";
		if (proc.stderr) {
			proc.stderr.on("data", (chunk: Buffer) => {
				stderrOutput = (stderrOutput + chunk.toString("utf-8")).slice(-8000);
			});
		}

		return new Promise<void>((resolve) => {
			proc.on("error", (err: Error) => {
				cleanup();
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
				cleanup();
				if (mySeq !== this.turnSeq) {
					resolve();
					return;
				}
				if (this.activeProcess === proc) this.activeProcess = null;
				if (this.aborted) {
					resolve();
					return;
				}

				if ((code !== 0 && code !== null) || this.resultFailed) {
					const errHint = this.lastErrorHint || stderrOutput.trim() || `Exit code ${code}`;
					sink.onError(`Claude Code 执行退出 (code ${code}): ${errHint}`);
				} else if (!this.turnCompleteEmitted) {
					const meta: AgentTurnMeta = { model: this.currentModel };
					sink.onTurnComplete(meta);
				}
				resolve();
			});
		});
	}

	private noteSessionId(sessionId: unknown, sink: AgentEventSink): void {
		if (typeof sessionId !== "string" || !sessionId || sessionId === this.activeSessionId) return;
		this.activeSessionId = sessionId;
		sink.onSessionStarted?.(sessionId);
	}

	private noteNativeCommands(event: Record<string, unknown>): void {
		const names = Array.isArray(event.slash_commands)
			? event.slash_commands.filter((n): n is string => typeof n === "string" && n.length > 0)
			: [];
		const skills = Array.isArray(event.skills) ? event.skills.filter((n): n is string => typeof n === "string") : [];
		if (names.join("\n") === this.nativeSlashCommands.join("\n")) return;
		this.nativeSlashCommands = names;
		this.nativeSkills = new Set(skills);
		this.slashCommandsChanged = true;
	}

	private handleClaudeEvent(event: Record<string, unknown>, sink: AgentEventSink): void {
		if (event.type === "stream_event" && event.event && typeof event.event === "object") {
			this.handleClaudeEvent(event.event as Record<string, unknown>, sink);
			return;
		}

		const type = String(event.type ?? "");

		if (type === "system") {
			this.noteSessionId(event.session_id, sink);
			if (event.subtype === "init") this.noteNativeCommands(event);
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
							this.startTool(block, sink);
						}
					}
				}
			}
			if (event.error) {
				this.lastErrorHint = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
			}
		}

		if (type === "user") {
			const msg = event.message as Record<string, unknown> | undefined;
			if (msg && Array.isArray(msg.content)) {
				for (const item of msg.content) {
					if (item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result") {
						this.endTool(item as Record<string, unknown>, sink);
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
			}
		}

		if (type === "content_block_start") {
			const block = event.content_block as Record<string, unknown> | undefined;
			if (block && block.type === "tool_use") this.startTool(block, sink);
		}

		if (type === "tool_use") this.startTool(event, sink);
		if (type === "tool_result") this.endTool(event, sink);

		if (type === "result") {
			this.noteSessionId(event.session_id, sink);
			if (event.is_error) {
				const detail = event.result ?? (Array.isArray(event.errors) ? event.errors.join("; ") : event.subtype);
				if (detail) this.lastErrorHint = typeof detail === "string" ? detail : JSON.stringify(detail);
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
			if (event.is_error) {
				this.resultFailed = true; // reported once on close, with lastErrorHint
				return;
			}
			this.turnCompleteEmitted = true;
			sink.onTurnComplete({
				usage: usage ? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUSD } : undefined,
				costUSD,
				contextTokens: inputTokens > 0 ? inputTokens + outputTokens : undefined,
				model: typeof event.model === "string" ? event.model : this.currentModel,
			});
		}
	}

	private startTool(block: Record<string, unknown>, sink: AgentEventSink): void {
		const callId = String(block.id ?? `tool_${Date.now()}`);
		if (this.seenToolStarts.has(callId)) return;
		this.seenToolStarts.add(callId);
		sink.onToolStart(callId, String(block.name ?? "tool"), (block.input as Record<string, unknown>) ?? {});
	}

	private endTool(block: Record<string, unknown>, sink: AgentEventSink): void {
		const toolId = String(block.tool_use_id ?? block.id ?? "");
		if (!toolId || this.seenToolEnds.has(toolId)) return;
		this.seenToolEnds.add(toolId);
		const content = toolResultText(block.content);
		sink.onToolEnd(toolId, block.is_error ? { error: content } : { output: content });
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
					spawn("taskkill", ["/pid", String(this.activeProcess.pid), "/t", "/f"], { windowsHide: true });
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
		const official = [...CLAUDE_CODE_MODELS];
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
		this.currentModel = normalizeClaudeModelId(modelId);
	}

	/** Native Claude Code commands and skills, as reported by the CLI's own init event. */
	override async getSlashCommands(): Promise<SlashCommandInfo[]> {
		return this.nativeSlashCommands
			.filter((name) => !PI_OWNED_SLASH.has(name))
			.map((name) => {
				const isSkill = this.nativeSkills.has(name);
				return {
					name,
					description: isSkill ? "Claude Code 技能" : "Claude Code 原生命令",
					descriptionEn: isSkill ? "Claude Code skill" : "Claude Code native command",
					source: "extension" as const,
				};
			});
	}

	override handlesNativeSlashCommand(name: string): boolean {
		if (PI_OWNED_SLASH.has(name)) return false;
		return name === "compact" || this.nativeSlashCommands.includes(name);
	}

	override consumeSlashCommandsChanged(): boolean {
		const changed = this.slashCommandsChanged;
		this.slashCommandsChanged = false;
		return changed;
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
