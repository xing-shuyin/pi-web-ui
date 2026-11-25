import type { SubagentSnapshot } from "../subagents.js";
import { SubagentRegistry, type SubagentRecord } from "../domains/subagents/registry.js";
import {
	createSubagentToolHost,
	type SubagentSnapshotSource,
	type SubagentSpawnSpec,
	type SubagentTemplateInfo,
} from "../domains/subagents/host.js";
import { createSubagentTool } from "../adapters/tools/subagent.js";
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
			if (runtime.options.transport.isClosed()) return;
			const reason = error instanceof Error ? error.message : String(error);
			runtime.options.transport.send({
				type: "notice",
				level: "warning",
				text: `子代理思考强度设置失败（将按当前档位运行）：${wanted}（${reason}）`,
				textEn: `Failed to set subagent thinking level, keeping the current one: ${wanted} (${reason})`,
			});
		}
	};
	const snapshotOf = (conv: Conversation, owner: ClientRuntime = runtime): SubagentSnapshot => {
		const record = registry.get(conv.id);
		const opened = owner.options.sessions?.get(conv.id);
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
			try {
				const sessionRegistry = ownerRuntime.options.sessions ?? sessions;
				const opened = await sessionRegistry.ensure(child);
				// 子代理会话的档位必须在第一轮之前落到 SDK 会话上：否则跑的是 SDK 默认档（不是模板、也不是派发者）。
				applyThinkingLevel(opened.session, parentId, spec);
				void ownerRuntime.turns.start(child, opened.session, spec.prompt).then(
					() => {
						registry.settle(child.id, { state: "done" });
					},
					(error: unknown) => {
						registry.settle(child.id, { state: "failed", error: String(error) });
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
