import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink } from "../universal/driver-base.js";
import type { AgentEngineCapabilities, PromptAttachment, SlashCommandInfo } from "../protocol.js";
import { openDurableStorage } from "./durable-storage.js";
import { setupDurableRegistry } from "./durable-tools.js";
import {
	listGlobalAvailableModels,
	setupDurableModels,
	resolveDurableModelChoice,
	resolveDurableThinkingLevels,
	type DurableModelInfo,
} from "./durable-models.js";
import { loadDurableModule, loadDurablePeerModule } from "./durable-loader.js";
import { DurableEventProjector } from "./durable-event-projector.js";
import { DEFAULT_DURABLE_CAPABILITIES } from "../engine-capabilities.js";

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

	override getEngineCapabilities(): AgentEngineCapabilities {
		return DEFAULT_DURABLE_CAPABILITIES;
	}

	private readonly dataDir: string;
	private readonly agentDir?: string;
	private currentModelId?: string;
	private cachedModels: DurableModelInfo[] = [];
	private aborted = false;

	private durableModule: any = null;
	private storage: any = null;
	private harness: any = null;
	private backgroundContext: any = null;
	private models: any = null;
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
		if (this.currentRunningConv && typeof this.currentRunningConv.configure === "function") {
			try {
				void this.currentRunningConv.configure({ thinkingLevel: level }, this.backgroundContext).catch(() => {});
			} catch {}
		} else if (this.harness && this.currentConversationId) {
			const numericId = Number(this.currentConversationId);
			if (Number.isSafeInteger(numericId) && numericId > 0 && typeof this.harness.conversation === "function") {
				void this.harness
					.conversation(numericId, this.backgroundContext)
					.then((conv: any) => {
						if (conv && typeof conv.configure === "function") {
							return conv.configure({ thinkingLevel: level }, this.backgroundContext);
						}
					})
					.catch(() => {});
			}
		}
	}

	override getSupportedThinkingLevels(modelId?: string): string[] {
		return resolveDurableThinkingLevels(modelId || this.currentModelId, {
			modelsContainer: this.models,
			cachedModels: this.cachedModels,
			agentDir: this.agentDir,
		});
	}

	public async ensureInitialized(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = (async () => {
			try {
				const chordModule = await loadDurablePeerModule("@earendil-works/chord", "context").catch(() => null);
				this.backgroundContext = chordModule?.BACKGROUND_CONTEXT ?? {};

				this.durableModule = await loadDurableModule().catch(() => null);

				if (!this.durableModule || typeof this.durableModule.Harness?.open !== "function") {
					this.initError = "@earendil-works/pi-durable 尚未安装或入口未找到";
					return;
				}

				const { storage } = await openDurableStorage(this.dataDir, this.cwd);
				this.storage = storage;

				const { registry } = await setupDurableRegistry(this.cwd);

				const models = await setupDurableModels(this.agentDir);
				this.models = models;

				const envModule = await loadDurableModule("env/node").catch(() => null);
				const envFactory = envModule?.NodeExecutionEnv
					? ({ cwd: callCwd }: any) => new envModule.NodeExecutionEnv({ cwd: callCwd || this.cwd })
					: undefined;

				this.harness = await this.durableModule.Harness.open(
					storage,
					{
						models,
						registry,
						...(envFactory ? { env: envFactory } : {}),
					},
					this.backgroundContext,
				);

				if (typeof this.harness.resume === "function") {
					this.harness.resume();
				}

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
				const agentOpts = {
					agent: {
						...(modelChoice ? { model: modelChoice } : {}),
						thinkingLevel: this.currentThinkingLevel,
					},
				};
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
			} catch {}
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
				const conv = await this.harness.conversation(numericId, this.backgroundContext);
				if (conv && typeof conv.agent === "function") {
					const agent = await conv.agent(this.backgroundContext).catch(() => null);
					if (agent?.thinkingLevel) {
						this.currentThinkingLevel = agent.thinkingLevel;
					}
				}
			} catch {}
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
				const agentOpts = {
					agent: {
						...(modelChoice ? { model: modelChoice } : {}),
						thinkingLevel: this.currentThinkingLevel,
					},
				};
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
		} catch {}
		return `durable-${Date.now()}`;
	}

	async sendPrompt(prompt: string, _attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void> {
		this.aborted = false;
		await this.ensureInitialized();

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
			const modelChoice = resolveDurableModelChoice(this.currentModelId, this.cachedModels, this.agentDir);
			const agentOpts = {
				agent: {
					...(modelChoice ? { model: modelChoice } : {}),
					thinkingLevel: this.currentThinkingLevel,
				},
			};

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

			if (typeof targetConv.configure === "function") {
				try {
					await targetConv.configure(
						{
							...(modelChoice ? { model: modelChoice } : {}),
							thinkingLevel: this.currentThinkingLevel,
						},
						this.backgroundContext,
					);
				} catch {}
			}

			this.currentRunningConv = targetConv;

			const projector = new DurableEventProjector();
			let watch: any = null;
			const watchEventsFn = this.durableModule?.watchEvents;
			const numericConvId = Number(targetConv?.id ?? this.currentConversationId);
			if (typeof watchEventsFn === "function" && Number.isSafeInteger(numericConvId) && numericConvId > 0) {
				try {
					watch = await watchEventsFn(this.harness, numericConvId, this.backgroundContext);
					this.activeWatch = watch;
					if (watch?.snapshot) projector.primeSnapshot(watch.snapshot, sink);
					watch.start(async (events: readonly unknown[]) => {
						if (this.aborted) return;
						projector.project(events, sink);
					});
				} catch {}
			}

			const submission = await targetConv.submit(
				{
					type: "input",
					content: prompt,
				},
				this.backgroundContext,
			);

			const settled = await submission.wait(this.backgroundContext);
			if (this.aborted) return;

			let finalUsage: any = undefined;
			if (settled.status === "done") {
				if (typeof settled.answer === "number" && this.storage && typeof this.storage.entry === "function") {
					try {
						const entryData = await this.storage.entry(settled.answer);
						const modelTurn = entryData?.entry?.model?.[0];
						finalUsage = modelTurn?.usage;
						if (modelTurn) projector.projectMessage(modelTurn, sink);
					} catch {}
				}

				if (!projector.emittedAnyText && settled.answer) {
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
			await this.haltActiveWatch();
			this.currentRunningConv = null;
		}
	}

	private haltActiveWatch(): Promise<void> {
		const watch = this.activeWatch;
		this.activeWatch = null;
		if (!watch) return Promise.resolve();
		try {
			const pending = typeof watch.cancel === "function" ? watch.cancel() : watch.stop?.();
			return Promise.resolve(pending)
				.then(() => undefined)
				.catch(() => undefined);
		} catch {
			return Promise.resolve();
		}
	}

	async abort(): Promise<void> {
		this.aborted = true;
		void this.haltActiveWatch();

		if (this.currentRunningConv && typeof this.currentRunningConv.abort === "function") {
			try {
				await this.currentRunningConv.abort(this.backgroundContext);
			} catch {}
		} else if (this.harness && typeof this.harness.root === "function") {
			try {
				const root = await this.harness.root(this.backgroundContext);
				if (root && typeof root.abort === "function") {
					await root.abort(this.backgroundContext);
				}
			} catch {}
		}
	}

	dispose(): void {
		this.aborted = true;
		if (this.harness && typeof this.harness.close === "function") {
			try {
				this.harness.close(this.backgroundContext);
			} catch {}
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
		} catch {}
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
							await conv.configure(
								{
									model: choice,
									thinkingLevel: this.currentThinkingLevel,
								},
								this.backgroundContext,
							);
						}
					}
				} catch {}
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
