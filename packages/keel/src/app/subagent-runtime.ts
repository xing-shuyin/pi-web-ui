import type { SubagentSnapshot } from "../subagents.js";
import { SubagentRegistry, type SubagentRecord } from "../domains/subagents/registry.js";
import {
	createSubagentToolHost,
	type SubagentSnapshotSource,
	type SubagentSpawnSpec,
	type SubagentTemplateInfo,
} from "../domains/subagents/host.js";
import { createSubagentTool } from "../adapters/tools/subagent.js";
import { modelKeyOf, parseModelId } from "../domains/models/project-memory.js";
import { getSubagentLedger } from "../subagent-ledger.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { TurnCapableSession } from "../contracts/session.js";
import type { ClientRuntime } from "./client-runtime.js";
import type { SessionRegistry } from "./session-registry.js";

export interface SubagentRuntimeOptions {
	runtime: ClientRuntime;
	sessions: SessionRegistry;
	now: () => number;
	fanoutMax?: number;
	depthMax?: number;
	registry?: SubagentRegistry;
	getRuntimes?: () => Iterable<ClientRuntime>;
	findRuntime?: (clientId: string) => ClientRuntime | undefined;
}

/** 账本状态与协议状态是两套词表：这里是唯一的翻译点（`canceled` 对应「被停掉」）。 */
function toWireState(state: SubagentRecord["state"] | undefined): SubagentSnapshot["state"] {
	if (state === "failed" || state === "stopped") return "canceled";
	return state ?? "running";
}
export interface SubagentRuntime {
	registry: SubagentRegistry;
	/** 给某个对话造 `subagent` 工具（工具里要带会话身份）。 */
	toolFor(conversationId: string | (() => string | undefined)): unknown;
	/** 回合结算/停止时同步账本；非子代理对话直接忽略。 */
	settle(conversationId: string, outcome: "done" | "failed" | "stopped", error?: string): void;
}

/**
 * 子代理的运行装配：账本（谁在跑）由 `domains/subagents` 给，快照（转录/输出）由会话投影给，
 * 派发/停止/steer 复用本客户端的会话持有与轮次执行——这里只做连线，不做策略。
 */
export function createSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntime {
	const { runtime, sessions } = options;
	const registry =
		options.registry ??
		new SubagentRegistry({
			now: options.now,
			...(options.fanoutMax === undefined ? {} : { fanoutMax: options.fanoutMax }),
			...(options.depthMax === undefined ? {} : { depthMax: options.depthMax }),
		});

	const isSubagent = (conv: Conversation): boolean => conv.meta.kind === "subagent";

	/**
	 * 模板清单的单一来源：设置帧那份投影（`SettingsFramePort.subagentTemplates()`）里只留启用项。
	 * 老实现的 `listTemplates` / `isTemplateUsable` 都在同一份过滤后的表上判（`agent-service.ts:4184`）。
	 */
	const templateRows = (): readonly SubagentTemplateInfo[] =>
		(runtime.options.settingsFrame?.()?.subagentTemplates() ?? [])
			.filter((template) => template.enabled)
			.map((template) => ({
				name: template.name,
				description: template.description,
				...(template.descriptionEn ? { descriptionEn: template.descriptionEn } : {}),
				...(template.model ? { model: template.model } : {}),
				...(template.thinkingLevel ? { thinkingLevel: template.thinkingLevel } : {}),
			}));

	const sendWarning = (text: string, textEn: string): void => {
		if (runtime.options.transport.isClosed()) return;
		runtime.options.transport.send({ type: "notice", level: "warning", text, textEn });
	};

	const ledgerFor = (owner: ClientRuntime) => {
		const dataDir = owner.options.stateStore?.()?.dataDir ?? runtime.options.stateStore?.()?.dataDir;
		return dataDir ? getSubagentLedger(dataDir) : undefined;
	};

	type CompletedNotice = {
		id: string;
		type: string;
		title: string;
		state: "done" | "failed";
		output: string;
		error?: string;
	};
	const pendingNotices = new Map<
		string,
		{ owner: ClientRuntime; timer?: ReturnType<typeof setTimeout>; items: CompletedNotice[] }
	>();
	const wakeBursts = new Map<string, { count: number; lastAt: number }>();

	const flushParentNotice = (parentId: string): void => {
		const entry = pendingNotices.get(parentId);
		if (!entry) return;
		pendingNotices.delete(parentId);
		if (entry.owner.isDisposed() || entry.items.length === 0) return;

		const now = options.now();
		const burst = wakeBursts.get(parentId);
		const count = burst && now - burst.lastAt < 60_000 ? burst.count + 1 : 1;
		wakeBursts.set(parentId, { count, lastAt: now });
		if (count > 2) return;

		const lines: string[] = [`[子代理执行完成通知] 共有 ${entry.items.length} 个子代理已完成：`, ""];
		for (const item of entry.items) {
			const badge = item.state === "done" ? "✅ 正常完成" : `❌ 执行失败${item.error ? `（${item.error}）` : ""}`;
			lines.push(`- **${item.id}**（${item.type} · ${item.title}）— ${badge}`);
			const summary = item.output.trim().slice(-500);
			if (summary) {
				lines.push(`  - 产出摘要:`);
				lines.push(`  > ${summary.replace(/\r?\n/g, "\n  > ")}`);
			}
		}
		const ledger = ledgerFor(entry.owner);
		for (const item of entry.items) {
			ledger?.upsert({
				runId: item.id,
				parentRunId: parentId,
				cwd: entry.owner.cwd,
				type: item.type,
				title: item.title,
				prompt: item.title,
				state: item.state,
				notifiedAt: now,
				createdAt: now,
				updatedAt: now,
				bootId: "",
				persisted: false,
			});
		}
		void entry.owner.noteConversation(parentId, lines.join("\n")).catch(() => {});
	};

	const enqueueParentNotice = (owner: ClientRuntime, parentId: string, item: CompletedNotice): void => {
		let entry = pendingNotices.get(parentId);
		if (!entry) {
			entry = { owner, items: [] };
			pendingNotices.set(parentId, entry);
		}
		entry.owner = owner;
		entry.items.push(item);
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => flushParentNotice(parentId), 400);
		entry.timer.unref?.();
	};

	/**
	 * 子代理的模型：`显式请求 → 模板模型 → 全局子代理默认模型 → 派发者当前模型`。
	 * 必须在 `applyThinkingLevel` 之前落到 SDK 会话上，这样思考强度能按新模型能力收敛。
	 */
	const applyModel = async (
		session: TurnCapableSession,
		ownerRuntime: ClientRuntime,
		parentId: string,
		spec: SubagentSpawnSpec,
	): Promise<void> => {
		if (!session.setModel) return;
		const template = spec.templateName ? templateRows().find((row) => row.name === spec.templateName) : undefined;
		const defaultModel =
			ownerRuntime.options.stateStore?.()?.getSettingsSnapshot(ownerRuntime.clientId)?.subagentDefaultModel?.trim() ||
			runtime.options.stateStore?.()?.getSettingsSnapshot(runtime.clientId)?.subagentDefaultModel?.trim() ||
			"";
		const wantedId = spec.model?.trim() || template?.model?.trim() || defaultModel;
		const parentSession = (ownerRuntime.options.sessions ?? sessions).get(parentId)?.session;

		if (wantedId) {
			const parsed = parseModelId(wantedId);
			const resolve = ownerRuntime.options.resolveModel ?? runtime.options.resolveModel;
			const resolved = parsed && resolve ? await resolve(parsed.provider, parsed.id) : undefined;
			if (resolved) {
				try {
					await session.setModel(resolved);
					return;
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					sendWarning(
						`子代理模型设置失败（将尝试跟随主对话）：${wantedId}（${reason}）`,
						`Failed to set subagent model, falling back to parent: ${wantedId} (${reason})`,
					);
				}
			} else {
				sendWarning(
					`子代理模型不可用（将尝试跟随主对话）：${wantedId}`,
					`Subagent model unavailable, falling back to parent: ${wantedId}`,
				);
			}
		}

		if (!parentSession?.model) return;
		try {
			await session.setModel(parentSession.model);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			sendWarning(
				`子代理继承主对话模型失败（将按默认模型运行）：${reason}`,
				`Failed to inherit parent model for subagent, keeping default: ${reason}`,
			);
		}
	};

	/**
	 * 子代理的思考强度：`显式请求 → 模板档位 → 派发者当前档位`（老实现 `agent-service.ts:2038` 同序）。
	 * 超出模型能力的档位由 SDK 自己收敛（`setThinkingLevel` 自带 clamp），收敛不算失败、不得发告警。
	 */
	const applyThinkingLevel = (session: TurnCapableSession, parentId: string, spec: SubagentSpawnSpec): void => {
		const template = spec.templateName ? templateRows().find((row) => row.name === spec.templateName) : undefined;
		const parentLevel = runtime.options.sessions?.get(parentId)?.session.thinkingLevel;
		const wanted = spec.thinking?.trim() || template?.thinkingLevel?.trim() || parentLevel;
		if (!wanted) return;
		try {
			session.setThinkingLevel?.(wanted);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			sendWarning(
				`子代理思考强度设置失败（将按当前档位运行）：${wanted}（${reason}）`,
				`Failed to set subagent thinking level, keeping the current one: ${wanted} (${reason})`,
			);
		}
	};
	const snapshotOf = (conv: Conversation, owner: ClientRuntime = runtime): SubagentSnapshot => {
		const record = registry.get(conv.id);
		const opened = owner.options.sessions?.get(conv.id);
		const modelKey = modelKeyOf(opened?.session.model);
		const model = modelKey ? `${modelKey.provider}/${modelKey.id}` : undefined;
		const thinkingLevel = opened?.session.thinkingLevel;
		return {
			convId: conv.id,
			type: record?.type ?? "general",
			title: record?.title ?? conv.meta.title,
			prompt: record?.prompt ?? conv.meta.title,
			state: toWireState(record?.state),
			streaming: conv.phase === "running",
			messageCount: opened?.session.messages?.length ?? 0,
			output: opened?.session.getLastAssistantText?.() ?? "",
			parentId: record?.parentId || conv.meta.parentId || undefined,
			...(model ? { model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(record?.error ? { error: record.error } : {}),
		};
	};

	const snapshots: SubagentSnapshotSource = {
		get: (id) => {
			const conv = runtime.registry.get(id);
			if (conv) return isSubagent(conv) ? snapshotOf(conv, runtime) : undefined;
			if (options.getRuntimes) {
				for (const other of options.getRuntimes()) {
					if (other === runtime) continue;
					const otherConv = other.registry.get(id);
					if (otherConv && isSubagent(otherConv)) return snapshotOf(otherConv, other);
				}
			}
			return undefined;
		},
		list: () => {
			const own = runtime.registry
				.list()
				.filter(isSubagent)
				.map((c) => snapshotOf(c, runtime));
			if (!options.getRuntimes) return own;
			const seen = new Set(own.map((s) => s.convId));
			for (const other of options.getRuntimes()) {
				if (other === runtime) continue;
				for (const child of other.registry.list().filter(isSubagent)) {
					if (!seen.has(child.id)) {
						seen.add(child.id);
						own.push(snapshotOf(child, other));
					}
				}
			}
			return own;
		},
	};

	const host = createSubagentToolHost({
		registry,
		snapshots,
		now: options.now,
		spawn: async (spec) => {
			const parentId = spec.parentId ?? runtime.activeConversationId();
			if (!parentId) throw new Error("子代理派发缺少父对话");
			registry.assertCanSpawn(parentId);

			let ownerRuntime = runtime;
			if (options.getRuntimes && !runtime.registry.has(parentId)) {
				for (const other of options.getRuntimes()) {
					if (other.registry.has(parentId)) {
						ownerRuntime = other;
						break;
					}
				}
			}

			const child = ownerRuntime.openChildConversation({
				parentId,
				title: spec.prompt.split("\n")[0]?.slice(0, 40) ?? spec.prompt.slice(0, 40),
				cwd: spec.cwd,
			});
			registry.register({ id: child.id, parentId, title: child.meta.title, type: spec.type, prompt: spec.prompt });
			ledgerFor(ownerRuntime)?.upsert({
				runId: child.id,
				parentRunId: parentId,
				cwd: child.meta.cwd,
				type: spec.type,
				title: child.meta.title,
				prompt: spec.prompt,
				state: "running",
				createdAt: options.now(),
				updatedAt: options.now(),
				bootId: "",
				persisted: Boolean(spec.persist),
			});
			try {
				const sessionRegistry = ownerRuntime.options.sessions ?? sessions;
				const opened = await sessionRegistry.ensure(child);
				// 子代理会话的模型与档位必须在第一轮之前落到 SDK 会话上：先设模型再设档位，否则跑的是 SDK 默认配置。
				await applyModel(opened.session, ownerRuntime, parentId, spec);
				applyThinkingLevel(opened.session, parentId, spec);
				void ownerRuntime.turns.start(child, opened.session, spec.prompt).then(
					() => {
						const settled = registry.get(child.id);
						if (settled?.state === "stopped") return;
						registry.settle(child.id, { state: "done" });
						const output = opened.session.getLastAssistantText?.() ?? "";
						const finishedAt = options.now();
						ledgerFor(ownerRuntime)?.upsert({
							runId: child.id,
							parentRunId: parentId,
							cwd: child.meta.cwd,
							type: spec.type,
							title: child.meta.title,
							prompt: spec.prompt,
							state: "done",
							outputTail: output,
							createdAt: finishedAt,
							finishedAt,
							updatedAt: finishedAt,
							bootId: "",
							persisted: Boolean(spec.persist),
						});
						if (spec.notifyOnDone !== false && spec.notifyOnDone !== "manual") {
							enqueueParentNotice(ownerRuntime, parentId, {
								id: child.id,
								type: spec.type,
								title: child.meta.title,
								state: "done",
								output,
							});
						}
					},
					(error: unknown) => {
						const settled = registry.get(child.id);
						if (settled?.state === "stopped") return;
						const msg = error instanceof Error ? error.message : String(error);
						registry.settle(child.id, { state: "failed", error: msg });
						const output = opened.session.getLastAssistantText?.() ?? "";
						const finishedAt = options.now();
						ledgerFor(ownerRuntime)?.upsert({
							runId: child.id,
							parentRunId: parentId,
							cwd: child.meta.cwd,
							type: spec.type,
							title: child.meta.title,
							prompt: spec.prompt,
							state: "failed",
							error: msg,
							outputTail: output,
							createdAt: finishedAt,
							finishedAt,
							updatedAt: finishedAt,
							bootId: "",
							persisted: Boolean(spec.persist),
						});
						if (spec.notifyOnDone !== false && spec.notifyOnDone !== "manual") {
							enqueueParentNotice(ownerRuntime, parentId, {
								id: child.id,
								type: spec.type,
								title: child.meta.title,
								state: "failed",
								output,
								error: msg,
							});
						}
					},
				);
			} catch (error) {
				registry.settle(child.id, { state: "failed", error: String(error) });
				throw error;
			}
			return child.id;
		},
		stop: async (id) => {
			let owner = runtime;
			if (options.getRuntimes && !runtime.registry.has(id)) {
				for (const other of options.getRuntimes()) {
					if (other.registry.has(id)) {
						owner = other;
						break;
					}
				}
			}
			owner.options.sessions?.close(id);
			registry.settle(id, { state: "stopped" });
		},
		steer: async (id, message) => {
			let owner = runtime;
			let conv = runtime.registry.get(id);
			if (!conv && options.getRuntimes) {
				for (const other of options.getRuntimes()) {
					const otherConv = other.registry.get(id);
					if (otherConv) {
						owner = other;
						conv = otherConv;
						break;
					}
				}
			}
			const opened = owner.options.sessions?.get(id);
			if (!conv || !opened) throw new Error(`子代理 ${id} 没有在跑的会话`);
			await owner.turns.steer(conv, opened.session, message);
		},
		templates: () => [...templateRows()],
		selfId: () => runtime.activeConversationId(),
	});

	return {
		registry,
		toolFor: (conversationId) => createSubagentTool(host, conversationId),
		settle: (conversationId, outcome, error) => {
			if (registry.get(conversationId)) {
				registry.settle(conversationId, error ? { state: outcome, error } : { state: outcome });
			}
		},
	};
}
