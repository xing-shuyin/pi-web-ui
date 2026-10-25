/**
 * dsh-driver.ts — DeepSeek Harness (DSH) 引擎驱动实现（基于 Universal Agent 底座）。
 *
 * 通过 stdio JSON-RPC 与 DSH 运行时子进程通信，将 DSH 的事件流、思考过程、工具调用与
 * 统计信息完整映射到 Universal 底座的 AgentEventSink。
 *
 * 特性：
 *   1. 原生流式 Thinking 与正文增量（reasoning-delta / text-delta）；
 *   2. 工具调用生命周期（tool/call → onToolStart, tool/result → onToolEnd）；
 *   3. 自动计算 Token 用量与缓存命中率（normalizeDshUsage）；
 *   4. 人在回路问卷提问桥（question.pending ↔ onAskUser）；
 *   5. 全量接入公共模型底座（models.json 自定义端点与多密钥动态注入）；
 *   6. 强杀中断与自愈恢复（abort → runtime.kill）。
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink, type AgentTurnMeta } from "../driver-base.js";
import type { PromptAttachment, SlashCommandInfo } from "../../protocol.js";
import { DshRuntime } from "../../dsh/dsh-client.js";
import { normalizeDshUsage } from "../../dsh/dsh-usage.js";
import { listCustomModelsFromConfig } from "../../model-resolver.js";
import { discoverDiskSkills } from "../../skill-discovery.js";

const DEFAULT_MODEL = "deepseek-v4-flash";

const DSH_OFFICIAL_MODELS = [
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek", vision: false },
	{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", vision: false },
	{
		id: "deepseek-v4-flash-vision-exp",
		name: "DeepSeek V4 Flash Vision (exp)",
		provider: "deepseek",
		vision: true,
	},
];

export interface DshAgentDriverOptions {
	agentDir?: string;
	dataDir?: string;
	defaultModel?: string;
	defaultProvider?: string;
	sessionRoot?: string;
	runtime?: DshRuntime;
}

export class DshAgentDriver extends BaseAgentDriver {
	readonly id = "dsh";
	readonly name = "DeepSeek Harness";
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: false,
		supportsHistoryEdit: false,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: true,
		supportsAskUser: true,
	};

	private readonly agentDir: string;
	private readonly dataDir: string;
	private readonly sessionRoot?: string;
	private currentModel: string;
	private currentProvider: string;
	private activeSessionId: string | null = null;
	private runtime: DshRuntime;
	private activeSink: AgentEventSink | null = null;
	private turnCompleteEmitted = false;

	constructor(cwd: string, opts?: DshAgentDriverOptions) {
		super(cwd);
		this.agentDir = opts?.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
		this.dataDir = opts?.dataDir || process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web");
		this.sessionRoot = opts?.sessionRoot;
		this.currentModel = opts?.defaultModel ?? DEFAULT_MODEL;
		this.currentProvider = opts?.defaultProvider ?? "deepseek";

		if (opts?.runtime) {
			this.runtime = opts.runtime;
		} else {
			this.runtime = new DshRuntime({
				cwd: this.cwd,
				provider: "deepseek-official",
				model: this.currentModel,
				modelProvider: this.currentProvider,
				sessionRoot: this.sessionRoot,
				dataDir: this.dataDir,
				agentDir: this.agentDir,
			});
		}

		this.setupNotificationHandler();
	}

	async createSession(): Promise<string> {
		const sessionId = `web-${randomUUID().slice(0, 12)}`;
		this.activeSessionId = sessionId;
		return sessionId;
	}

	async resumeSession(sessionId: string): Promise<void> {
		this.activeSessionId = sessionId;
	}

	getActiveSessionId(): string | null {
		return this.activeSessionId;
	}

	override getSupportedThinkingLevels(): string[] {
		return ["high"];
	}

	/** 绑定运行时通知事件分发到 Universal 底座的 sink */
	private setupNotificationHandler(): void {
		this.runtime.onNotification((method: string, params: unknown) => {
			const sink = this.activeSink;
			if (!sink || typeof params !== "object" || params === null) return;
			const p = params as Record<string, unknown>;

			if (method === "session.event") {
				const event = p.event as Record<string, unknown> | undefined;
				if (!event) return;
				const type = String(event.type ?? "");
				const data = (event.data ?? {}) as Record<string, unknown>;

				switch (type) {
					case "assistant/chunk": {
						const chunk = (data.chunk ?? {}) as Record<string, unknown>;
						const chunkType = String(chunk.type ?? "");
						if (chunkType === "reasoning-delta" && chunk.text) {
							sink.onThinkingDelta(String(chunk.text));
						} else if (chunkType === "text-delta" && chunk.text) {
							sink.onTextDelta(String(chunk.text));
						}
						break;
					}

					case "tool/call": {
						const callId = String(data.id ?? `call_${Date.now()}`);
						const toolName = String(data.name ?? "unknown");
						const args = (data.args ?? {}) as Record<string, unknown>;
						sink.onToolStart(callId, toolName, args);
						break;
					}

					case "tool/result": {
						const message = (data.message ?? {}) as Record<string, unknown>;
						const contentList = Array.isArray(message.content) ? message.content : [];
						const tr = contentList.find((b: unknown) => (b as Record<string, unknown>)?.type === "tool-result") as
							Record<string, unknown> | undefined;
						const callId = String(tr?.toolCallId ?? data.id ?? "");
						const isError = Boolean(tr?.isError ?? data.isError);
						const rawText = Array.isArray(tr?.content)
							? tr.content.map((c: any) => c?.text ?? "").join("\n")
							: String(data.result ?? "");
						sink.onToolEnd(callId, {
							output: isError ? undefined : rawText,
							error: isError ? rawText : undefined,
						});
						break;
					}

					case "assistant/message": {
						const message = (data.message ?? {}) as Record<string, unknown>;
						const usage = message.usage ? normalizeDshUsage(message.usage) : null;
						const meta: AgentTurnMeta = {
							model: this.currentModel,
							usage: usage
								? {
										inputTokens: usage.input,
										outputTokens: usage.output,
										cacheReadTokens: usage.cacheRead,
										cacheWriteTokens: usage.cacheWrite,
									}
								: undefined,
						};
						if (!this.turnCompleteEmitted) {
							this.turnCompleteEmitted = true;
							sink.onTurnComplete(meta);
						}
						break;
					}
				}
			} else if (method === "question.pending") {
				if (sink.onAskUser && p.id && typeof p.question === "string") {
					const qId = String(p.id);
					const qText = String(p.question);
					const options = Array.isArray(p.options)
						? (p.options as Array<{ id: string; label: string; description?: string }>)
						: undefined;
					sink
						.onAskUser(qId, qText, options)
						.then((answers) => {
							return this.runtime.answerQuestion(qId, [
								{ id: qId, selected: answers.selected, custom: answers.custom },
							]);
						})
						.catch(() => {
							return this.runtime.answerQuestion(qId, [], true);
						});
				}
			} else if (method === "session.status") {
				if (p.status === "idle" && !this.turnCompleteEmitted) {
					this.turnCompleteEmitted = true;
					sink.onTurnComplete({ model: this.currentModel });
				}
			}
		});
	}

	async sendPrompt(prompt: string, attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void> {
		this.activeSink = sink;
		this.turnCompleteEmitted = false;

		if (!this.activeSessionId) {
			await this.createSession();
		}
		const sessionId = this.activeSessionId!;

		await this.runtime.start();

		// 构建 contentBlocks
		const contentBlocks: unknown[] = [];

		// 处理图片和文件附件
		if (attachments && attachments.length > 0) {
			for (const att of attachments) {
				if (att.imageData) {
					try {
						const name = att.name || "image.png";
						const mime = name.endsWith(".png")
							? "image/png"
							: name.endsWith(".gif")
								? "image/gif"
								: name.endsWith(".webp")
									? "image/webp"
									: "image/jpeg";
						const res = await this.runtime.attachmentSave(mime, att.imageData, name);
						if (res.ref) {
							contentBlocks.push({ type: "image", attachmentRef: res.ref });
						}
					} catch {
						/* 回落内联 */
					}
				} else if (att.path) {
					contentBlocks.push({
						type: "text",
						text: `[Attachment: ${att.name || att.path}]\n${att.path}`,
					});
				}
			}
		}

		contentBlocks.push({ type: "text", text: prompt });

		let turnDoneResolve!: () => void;
		const turnPromise = new Promise<void>((resolve) => {
			turnDoneResolve = resolve;
		});

		// 代理 sink 以获知完成时点
		const wrappedSink: AgentEventSink = {
			onTextDelta: (d) => sink.onTextDelta(d),
			onThinkingDelta: (d) => sink.onThinkingDelta(d),
			onToolStart: (id, name, args) => sink.onToolStart(id, name, args),
			onToolUpdate: (id, out) => sink.onToolUpdate?.(id, out),
			onToolEnd: (id, res) => sink.onToolEnd(id, res),
			onAskUser: sink.onAskUser ? (id, q, opts) => sink.onAskUser!(id, q, opts) : undefined,
			onTurnComplete: (meta) => {
				sink.onTurnComplete(meta);
				turnDoneResolve();
			},
			onError: (err) => {
				sink.onError(err);
				turnDoneResolve();
			},
		};
		this.activeSink = wrappedSink;

		try {
			await this.runtime.prompt(sessionId, contentBlocks);
			await turnPromise;
		} catch (err) {
			wrappedSink.onError(err instanceof Error ? err : new Error(String(err)));
		} finally {
			this.activeSink = null;
		}
	}

	async abort(): Promise<void> {
		await this.runtime.kill();
	}

	async listModels(): Promise<Array<{ id: string; name: string }>> {
		const official = DSH_OFFICIAL_MODELS.map((m) => ({
			id: `deepseek/${m.id}`,
			name: m.name,
		}));

		let dynamic: Array<{ id: string; name: string }> = [];
		try {
			if (this.runtime.alive) {
				const res = await this.runtime.listModels();
				dynamic = (res.models ?? []).map((m) => ({
					id: m.id.includes("/") ? m.id : `deepseek/${m.id}`,
					name: m.name || m.id,
				}));
			}
		} catch {
			/* ignore */
		}

		let custom: Array<{ id: string; name: string }> = [];
		try {
			const customList = listCustomModelsFromConfig(this.agentDir);
			custom = customList.map((c) => ({
				id: `${c.providerId}/${c.modelId}`,
				name: c.name,
			}));
		} catch {
			/* ignore */
		}

		const seen = new Set<string>();
		const result: Array<{ id: string; name: string }> = [];
		for (const m of [...official, ...dynamic, ...custom]) {
			if (!seen.has(m.id)) {
				seen.add(m.id);
				result.push(m);
			}
		}
		return result;
	}

	async setModel(modelId: string): Promise<void> {
		const normId = modelId.trim();
		const hasSlash = normId.includes("/");
		const targetProvider = hasSlash ? normId.slice(0, normId.indexOf("/")) : "deepseek";
		const bareModelId = hasSlash ? normId.slice(normId.indexOf("/") + 1) : normId;

		this.currentModel = bareModelId;
		this.currentProvider = targetProvider;
		await this.runtime.restart(bareModelId, targetProvider);
	}

	override async getSlashCommands(): Promise<SlashCommandInfo[]> {
		return [
			{
				name: "skills",
				description: "查看 DeepSeek Harness 运行时与磁盘技能列表",
				descriptionEn: "List DeepSeek Harness runtime and disk skills",
				source: "extension",
			},
			{
				name: "clear",
				description: "重置 DSH 会话上下文",
				descriptionEn: "Reset DSH session context",
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
			case "skills": {
				const skills = await this.getSkills();
				const summary =
					skills.length > 0
						? `DSH 可用技能 (${skills.length})：${skills.map((s) => s.name).join(", ")}`
						: "DSH 当前无可用技能";
				const summaryEn =
					skills.length > 0
						? `DSH skills (${skills.length}): ${skills.map((s) => s.name).join(", ")}`
						: "No DSH skills available";
				context?.emitNotice?.("info", summary, summaryEn);
				return true;
			}
			case "clear": {
				await this.createSession();
				context?.emitNotice?.("info", "DSH 会话上下文已重置", "DSH session context reset");
				return true;
			}
			default:
				return false;
		}
	}

	override async getSkills(): Promise<Array<{ name: string; description: string; filePath?: string }>> {
		const diskSkills = discoverDiskSkills({ cwd: this.cwd, agentDir: this.agentDir });
		const out: Array<{ name: string; description: string; filePath?: string }> = diskSkills.map((s) => ({
			name: s.name,
			description: s.description,
			filePath: s.filePath,
		}));

		try {
			if (this.runtime.alive) {
				const rpcSkills = await this.runtime.listSkills();
				for (const s of rpcSkills.skills ?? []) {
					if (!out.some((x) => x.name === s.name)) {
						out.push({
							name: s.name,
							description: s.description,
							filePath: "",
						});
					}
				}
			}
		} catch {
			/* ignore runtime error */
		}

		return out;
	}

	dispose(): void {
		void this.runtime.close();
	}
}
