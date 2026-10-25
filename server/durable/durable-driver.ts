/**
 * durable-driver.ts — Pi Durable 独立智能体驱动（继承 BaseAgentDriver）。
 *
 * 职责：
 * 1. 动态加载 @earendil-works/pi-durable 核心包及 SQLite 持久化仓储；
 * 2. 将用户输入转化为事务性提交（conversation.submit），向 AgentEventSink 发射思考、正文与工具事件；
 * 3. 具备任务图（Task Graph）级联中断与崩溃自愈（harness.resume()）；
 * 4. 当宿主尚未安装核心包时，向用户友好呈现安装引导与状态提示。
 */

import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink } from "../universal/driver-base.js";
import type { PromptAttachment, SlashCommandInfo } from "../protocol.js";
import { openDurableStorage } from "./durable-storage.js";
import { setupDurableRegistry } from "./durable-tools.js";
import {
	listGlobalAvailableModels,
	setupDurableModels,
	resolveDurableModelChoice,
	type DurableModelInfo,
} from "./durable-models.js";
import { loadDurableModule, loadDurablePeerModule } from "./durable-loader.js";

export class DurableAgentDriver extends BaseAgentDriver {
	readonly id = "durable";
	readonly name = "Pi Durable Agent";
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: true,
		supportsHistoryEdit: true,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: true,
		supportsAskUser: true,
		supportsSubagents: true,
	};

	private readonly dataDir: string;
	private readonly agentDir?: string;
	private currentModelId?: string;
	private cachedModels: DurableModelInfo[] = [];
	private aborted = false;

	// Pi Durable 动态模块与运行时单例
	private durableModule: any = null;
	private storage: any = null;
	private harness: any = null;
	private backgroundContext: any = null;
	private initPromise: Promise<void> | null = null;
	private initError: string | null = null;
	private currentConversationId: string | null = null;
	private activeWatch: any = null;
	private currentRunningConv: any = null;
	private currentThinkingLevel: string = "medium";

	constructor(cwd: string, opts?: { dataDir?: string; agentDir?: string }) {
		super(cwd);
		this.dataDir = opts?.dataDir ?? process.cwd();
		this.agentDir = opts?.agentDir;
	}

	override setThinkingLevel(level: string): void {
		this.currentThinkingLevel = level;
	}

	override getSupportedThinkingLevels(): string[] {
		return ["off", "low", "medium", "high"];
	}

	/**
	 * 初始化 Pi Durable 运行环境（按需异步单例）。
	 */
	public async ensureInitialized(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = (async () => {
			try {
				// 1. 动态加载 Chord 上下文（支持全局 node_modules 自动发现）
				const chordModule = await loadDurablePeerModule("@earendil-works/chord", "context").catch(() => null);
				this.backgroundContext = chordModule?.BACKGROUND_CONTEXT ?? {};

				// 2. 动态加载 Durable 核心模块（支持本地/全局安装包自动发现）
				this.durableModule = await loadDurableModule().catch(() => null);

				if (!this.durableModule || typeof this.durableModule.Harness?.open !== "function") {
					this.initError = "@earendil-works/pi-durable 尚未安装或入口未找到";
					return;
				}

				// 3. 打开持久化存储（SQLite WAL 优先）
				const { storage } = await openDurableStorage(this.dataDir, this.cwd);
				this.storage = storage;

				// 4. 装配工具与扩展注册表
				const { registry } = await setupDurableRegistry(this.cwd);

				// 5. 继承全局模型配置（读取 models.json、auth.json 并装配 Providers）
				const models = await setupDurableModels(this.agentDir);

				// 6. 动态加载本地执行环境（支撑 read/write/edit/bash 等官方编码工具）
				const envModule = await loadDurableModule("env/node").catch(() => null);
				const envFactory = envModule?.NodeExecutionEnv
					? ({ cwd: callCwd }: any) => new envModule.NodeExecutionEnv({ cwd: callCwd || this.cwd })
					: undefined;

				// 7. 开启 Harness
				this.harness = await this.durableModule.Harness.open(
					storage,
					{
						models,
						registry,
						...(envFactory ? { env: envFactory } : {}),
					},
					this.backgroundContext,
				);

				// 8. ⭐ 崩溃自愈：调度未完成的长任务续跑
				if (typeof this.harness.resume === "function") {
					this.harness.resume();
				}

				// 8. 预热模型名录并确定缺省活动模型
				if (this.cachedModels.length === 0) {
					await this.listModels().catch(() => []);
				}
				if (!this.currentModelId) {
					const defaultChoice = resolveDurableModelChoice(undefined, this.cachedModels, this.agentDir);
					if (defaultChoice) {
						this.currentModelId = `${defaultChoice.provider}/${defaultChoice.modelId}`;
					}
				}
			} catch (err: any) {
				this.initError = err?.message || String(err);
			}
		})();
		return this.initPromise;
	}

	async createSession(): Promise<string> {
		await this.ensureInitialized();
		if (this.harness && typeof this.harness.createConversation === "function") {
			try {
				const modelChoice = resolveDurableModelChoice(this.currentModelId, this.cachedModels, this.agentDir);
				const agentOpts = modelChoice ? { agent: { model: modelChoice } } : {};
				const conv = await this.harness.createConversation(
					{
						ownership: { kind: "ownerless" },
						...agentOpts,
					},
					this.backgroundContext,
				);
				const sid = String(conv?.id ?? `durable-${Date.now()}`);
				this.currentConversationId = sid;
				return sid;
			} catch {
				/* fallback */
			}
		}
		const fallbackId = `durable-${Date.now()}`;
		this.currentConversationId = fallbackId;
		return fallbackId;
	}

	async resumeSession(sessionId: string): Promise<void> {
		await this.ensureInitialized();
		this.currentConversationId = sessionId;
		const numericId = Number(sessionId);
		if (
			Number.isSafeInteger(numericId) &&
			numericId > 0 &&
			this.harness &&
			typeof this.harness.conversation === "function"
		) {
			try {
				await this.harness.conversation(numericId, this.backgroundContext);
			} catch {
				/* fallback */
			}
		}
	}

	override async forkSession(sessionId: string, atEntryId?: number): Promise<string> {
		await this.ensureInitialized();
		if (!this.harness || typeof this.harness.conversation !== "function") {
			return `durable-${Date.now()}`;
		}
		const numericId = Number(sessionId);
		if (!Number.isSafeInteger(numericId) || numericId <= 0) {
			return `durable-${Date.now()}`;
		}
		try {
			const parentConv = await this.harness.conversation(numericId, this.backgroundContext);
			if (parentConv && typeof parentConv.fork === "function") {
				const modelChoice = resolveDurableModelChoice(this.currentModelId, this.cachedModels, this.agentDir);
				const agentOpts = modelChoice ? { agent: { model: modelChoice } } : {};
				const forked = await parentConv.fork(
					atEntryId,
					{
						ownership: { kind: "ownerless" },
						...agentOpts,
					},
					this.backgroundContext,
				);
				const forkedId = String(forked?.id ?? `durable-${Date.now()}`);
				this.currentConversationId = forkedId;
				return forkedId;
			}
		} catch {
			/* fallback */
		}
		return `durable-${Date.now()}`;
	}

	async sendPrompt(prompt: string, _attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void> {
		this.aborted = false;
		await this.ensureInitialized();

		// 如果未安装 @earendil-works/pi-durable，安全返回引导提示
		if (!this.harness || this.initError) {
			sink.onTextDelta(
				"【Pi Durable 引擎就绪检查】\n\n" +
					"当前宿主环境尚未安装或加载 `@earendil-works/pi-durable` 核心运行时包。\n\n" +
					"请在终端中执行以下命令进行全局安装：\n" +
					"```bash\n" +
					"npm i -g @earendil-works/pi-durable\n" +
					"```\n" +
					"安装完成后，刷新浏览器标签页即可直接启用基于 SQLite/WAL 事务化检查点与自愈的 Durable 智能体会话。",
			);
			sink.onTurnComplete({
				costUSD: 0,
				contextTokens: 0,
				model: "pi-durable-pending",
			});
			return;
		}

		try {
			// 获取当前活动会话或工作区根会话
			const modelChoice = resolveDurableModelChoice(this.currentModelId, this.cachedModels, this.agentDir);
			const agentOpts = modelChoice ? { agent: { model: modelChoice } } : undefined;

			let targetConv: any = null;
			const numericId = this.currentConversationId ? Number(this.currentConversationId) : NaN;
			if (
				Number.isSafeInteger(numericId) &&
				numericId > 0 &&
				this.harness &&
				typeof this.harness.conversation === "function"
			) {
				targetConv = await this.harness.conversation(numericId, this.backgroundContext).catch(() => null);
			}
			if (!targetConv) {
				targetConv = await this.harness.root(this.backgroundContext, agentOpts);
			}
			if (this.aborted) return;

			// 若指定了模型选择，确保目标会话已应用最新模型配置
			if (modelChoice && typeof targetConv.configure === "function") {
				try {
					await targetConv.configure({ model: modelChoice }, this.backgroundContext);
				} catch {
					/* best effort */
				}
			}

			this.currentRunningConv = targetConv;

			// 启动 Durable 反应式实时流 (LiveDoc / entries / tools 增量监听)
			let emittedTextLen = 0;
			let emittedThinkingLen = 0;
			const startedToolCalls = new Set<string>();
			const finishedToolCalls = new Set<string>();

			let watch: any = null;
			if (typeof targetConv.watch === "function") {
				try {
					watch = await targetConv.watch(this.backgroundContext);
					this.activeWatch = watch;
					watch.start((value: any) => {
						if (this.aborted) return;
						const live = value?.docs?.["pi.live"];
						if (!live) return;

						// 1. 实时流式捕获思考与正文内容
						const genMessage = live.generation?.message;
						if (genMessage?.content && Array.isArray(genMessage.content)) {
							for (const block of genMessage.content) {
								if (block.type === "thinking" && typeof block.thinking === "string") {
									const delta = block.thinking.slice(emittedThinkingLen);
									if (delta) {
										emittedThinkingLen = block.thinking.length;
										sink.onThinkingDelta(delta);
									}
								} else if (block.type === "text" && typeof block.text === "string") {
									const delta = block.text.slice(emittedTextLen);
									if (delta) {
										emittedTextLen = block.text.length;
										sink.onTextDelta(delta);
									}
								}
							}
						}

						// 2. 实时流式捕获任务图中的工具槽位执行状态
						const toolSlots = live.tools || live.nestedTools;
						if (Array.isArray(toolSlots)) {
							for (const slot of toolSlots) {
								if (!slot || !slot.callId) continue;
								const callId = String(slot.callId);

								// 工具开始运行：发射 onToolStart
								if (!startedToolCalls.has(callId) && (slot.status === "running" || slot.status === "done")) {
									startedToolCalls.add(callId);
									sink.onToolStart?.(callId, slot.name || slot.tool || "tool", slot.input ?? {});
								}

								// 工具执行结束：发射 onToolEnd
								if (
									startedToolCalls.has(callId) &&
									!finishedToolCalls.has(callId) &&
									(slot.status === "done" || slot.status === "error")
								) {
									finishedToolCalls.add(callId);
									const outputText =
										typeof slot.output === "string"
											? slot.output
											: slot.output
												? JSON.stringify(slot.output, null, 2)
												: "";
									sink.onToolEnd?.(callId, {
										output: outputText,
										error: slot.error ? String(slot.error) : undefined,
									});
								}
							}
						}
					});
				} catch {
					/* watch 启动失败安全回退到等待模式 */
				}
			}

			// 提交任务到 Durable 引擎
			const submission = await targetConv.submit(
				{
					type: "input",
					content: prompt,
				},
				this.backgroundContext,
			);

			// 等待提交执行结果
			const settled = await submission.wait(this.backgroundContext);
			if (this.aborted) return;

			let finalUsage: any = undefined;
			if (settled.status === "done") {
				// 当 answer 为已持久化的 entryId (数字) 时，从存储核对并补发未完全覆写的残余文本与元数据
				if (typeof settled.answer === "number" && this.storage && typeof this.storage.entry === "function") {
					try {
						const entryData = await this.storage.entry(settled.answer);
						const modelTurn = entryData?.entry?.model?.[0];
						finalUsage = modelTurn?.usage;
						if (modelTurn?.content && Array.isArray(modelTurn.content)) {
							for (const block of modelTurn.content) {
								if (block.type === "thinking" && typeof block.thinking === "string") {
									const delta = block.thinking.slice(emittedThinkingLen);
									if (delta) {
										emittedThinkingLen = block.thinking.length;
										sink.onThinkingDelta(delta);
									}
								} else if (block.type === "text" && typeof block.text === "string") {
									const delta = block.text.slice(emittedTextLen);
									if (delta) {
										emittedTextLen = block.text.length;
										sink.onTextDelta(delta);
									}
								}
							}
						}
					} catch {
						/* fallback */
					}
				}

				// 若流式期间未发射出正文且 answer 为文本或对象，进行最终保底输出
				if (emittedTextLen === 0 && settled.answer) {
					const text = typeof settled.answer === "string" ? settled.answer : JSON.stringify(settled.answer);
					sink.onTextDelta(text);
				}
			} else if (settled.status === "unanswered") {
				const detail = settled.detail ? ` (${settled.detail})` : "";
				sink.onTextDelta(`[Durable 任务未完成: ${settled.reason ?? "未知原因"}${detail}]`);
			}

			sink.onTurnComplete({
				costUSD: finalUsage?.cost?.total ?? 0,
				contextTokens: finalUsage?.totalTokens ?? 100,
				model: this.currentModelId || "pi-durable",
				usage: finalUsage
					? {
							inputTokens: finalUsage.input,
							outputTokens: finalUsage.output,
							cacheReadTokens: finalUsage.cacheRead,
							cacheWriteTokens: finalUsage.cacheWrite,
							costUSD: finalUsage.cost?.total,
						}
					: undefined,
			});
		} catch (err: any) {
			if (this.aborted) return;
			const causeMsg = err?.cause?.message ? ` (${err.cause.message})` : "";
			sink.onTextDelta(`[Pi Durable 运行时执行错误]: ${err?.message || String(err)}${causeMsg}`);
			// 若底层会话已损坏，及时重置句柄以便下一次请求自动重连自愈
			if (err?.name === "SessionFailed" || String(err?.message).includes("Session failed")) {
				this.harness = null;
				this.initPromise = null;
			}
			sink.onTurnComplete({
				costUSD: 0,
				contextTokens: 0,
				model: "pi-durable-error",
			});
		} finally {
			if (this.activeWatch) {
				try {
					await this.activeWatch.stop();
				} catch {
					/* ignore */
				}
				this.activeWatch = null;
			}
			this.currentRunningConv = null;
		}
	}

	async abort(): Promise<void> {
		this.aborted = true;
		if (this.activeWatch) {
			try {
				this.activeWatch.cancel();
			} catch {
				/* ignore */
			}
			this.activeWatch = null;
		}

		if (this.currentRunningConv && typeof this.currentRunningConv.abort === "function") {
			try {
				await this.currentRunningConv.abort(this.backgroundContext);
			} catch {
				/* best effort */
			}
		} else if (this.harness && typeof this.harness.root === "function") {
			try {
				const root = await this.harness.root(this.backgroundContext);
				if (root && typeof root.abort === "function") {
					await root.abort(this.backgroundContext);
				}
			} catch {
				/* best effort */
			}
		}
	}

	dispose(): void {
		this.aborted = true;
		if (this.harness && typeof this.harness.close === "function") {
			try {
				this.harness.close(this.backgroundContext);
			} catch {
				/* ignore */
			}
			this.harness = null;
		}
	}

	override async listModels(): Promise<Array<{ id: string; name: string }>> {
		try {
			this.cachedModels = await listGlobalAvailableModels(this.cwd, this.agentDir);
			if (this.cachedModels.length > 0) {
				return this.cachedModels.map((m) => ({
					id: m.id,
					name: m.name,
				}));
			}
		} catch {
			/* best effort */
		}
		return [
			{ id: "openai/gpt-4o", name: "GPT-4o" },
			{ id: "anthropic/claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
		];
	}

	override async setModel(modelId: string): Promise<void> {
		this.currentModelId = modelId;
		if (this.harness && this.currentConversationId) {
			const numericId = Number(this.currentConversationId);
			if (Number.isSafeInteger(numericId) && numericId > 0 && typeof this.harness.conversation === "function") {
				try {
					const conv = await this.harness.conversation(numericId, this.backgroundContext);
					if (conv && typeof conv.configure === "function") {
						const choice = resolveDurableModelChoice(modelId, this.cachedModels, this.agentDir);
						if (choice) {
							await conv.configure({ model: choice }, this.backgroundContext);
						}
					}
				} catch {
					/* best effort */
				}
			}
		}
	}

	override async getSlashCommands(): Promise<SlashCommandInfo[]> {
		return [
			{
				name: "durable-status",
				description: "查看 Pi Durable 存储与任务图状态",
				descriptionEn: "Check Pi Durable storage and task graph status",
				source: "builtin",
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
		if (name === "durable-status") {
			const statusText = this.harness
				? "Pi Durable 引擎状态正常运行中（存储就绪，任务调度器已激活）。"
				: `Pi Durable 尚未装配: ${this.initError ?? "未就绪"}`;
			context?.emitNotice?.("info", statusText, statusText);
			return true;
		}
		return false;
	}
}
