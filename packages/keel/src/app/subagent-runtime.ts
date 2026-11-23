import type { SubagentSnapshot } from "../subagents.js";
import { SubagentRegistry, type SubagentRecord } from "../domains/subagents/registry.js";
import { createSubagentToolHost, type SubagentSnapshotSource } from "../domains/subagents/host.js";
import { createSubagentTool } from "../adapters/tools/subagent.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { ClientRuntime } from "./client-runtime.js";
import type { SessionRegistry } from "./session-registry.js";

export interface SubagentRuntimeOptions {
	runtime: ClientRuntime;
	sessions: SessionRegistry;
	now: () => number;
	fanoutMax?: number;
	depthMax?: number;
}

/** 账本状态与协议状态是两套词表：这里是唯一的翻译点（`canceled` 对应「被停掉」）。 */
function toWireState(state: SubagentRecord["state"] | undefined): SubagentSnapshot["state"] {
	if (state === "failed" || state === "stopped") return "canceled";
	return state ?? "running";
}
export interface SubagentRuntime {
	registry: SubagentRegistry;
	/** 给某个对话造 `subagent` 工具（工具里要带会话身份）。 */
	toolFor(conversationId: string): unknown;
	/** 回合结算/停止时同步账本；非子代理对话直接忽略。 */
	settle(conversationId: string, outcome: "done" | "failed" | "stopped", error?: string): void;
}

/**
 * 子代理的运行装配：账本（谁在跑）由 `domains/subagents` 给，快照（转录/输出）由会话投影给，
 * 派发/停止/steer 复用本客户端的会话持有与轮次执行——这里只做连线，不做策略。
 */
export function createSubagentRuntime(options: SubagentRuntimeOptions): SubagentRuntime {
	const { runtime, sessions } = options;
	const specs = new Map<string, { type: string; prompt: string }>();
	const registry = new SubagentRegistry({
		now: options.now,
		...(options.fanoutMax === undefined ? {} : { fanoutMax: options.fanoutMax }),
		...(options.depthMax === undefined ? {} : { depthMax: options.depthMax }),
	});

	const isSubagent = (conv: Conversation): boolean => conv.meta.kind === "subagent";
	const snapshotOf = (conv: Conversation): SubagentSnapshot => {
		const record = registry.get(conv.id);
		const spec = specs.get(conv.id);
		const opened = sessions.get(conv.id);
		return {
			convId: conv.id,
			type: record?.type ?? spec?.type ?? "general",
			title: record?.title ?? conv.meta.title,
			prompt: spec?.prompt ?? conv.meta.title,
			state: toWireState(record?.state),
			streaming: conv.phase === "running",
			messageCount: opened?.session.messages?.length ?? 0,
			output: opened?.session.getLastAssistantText?.() ?? "",
			parentId: record?.parentId || undefined,
			...(record?.error ? { error: record.error } : {}),
		};
	};

	const snapshots: SubagentSnapshotSource = {
		get: (id) => {
			const conv = runtime.registry.get(id);
			if (conv) return isSubagent(conv) ? snapshotOf(conv) : undefined;
			for (const child of runtime.registry.list()) {
				if (!isSubagent(child)) continue;
				if (child.id === id) return snapshotOf(child);
			}
			return undefined;
		},
		list: () => runtime.registry.list().filter(isSubagent).map(snapshotOf),
	};

	const host = createSubagentToolHost({
		registry,
		snapshots,
		now: options.now,
		spawn: async (spec) => {
			const parentId = spec.parentId ?? runtime.activeConversationId();
			if (!parentId) throw new Error("子代理派发缺少父对话");
			registry.assertCanSpawn(parentId);
			const child = runtime.createConversation({
				kind: "subagent",
				parentId,
				title: spec.prompt.split("\n")[0]?.slice(0, 40) ?? spec.prompt.slice(0, 40),
				cwd: spec.cwd,
			});
			specs.set(child.id, { type: spec.type, prompt: spec.prompt });
			registry.register({ id: child.id, parentId, title: child.meta.title, type: spec.type });
			try {
				const opened = await sessions.ensure(child);
				void runtime.turns.start(child, opened.session, spec.prompt).catch((error: unknown) => {
					registry.settle(child.id, { state: "failed", error: String(error) });
				});
			} catch (error) {
				registry.settle(child.id, { state: "failed", error: String(error) });
				throw error;
			}
			return child.id;
		},
		stop: async (id) => {
			sessions.close(id);
			registry.settle(id, { state: "stopped" });
		},
		steer: async (id, message) => {
			const conv = runtime.registry.get(id);
			const opened = sessions.get(id);
			if (!conv || !opened) throw new Error(`子代理 ${id} 没有在跑的会话`);
			await runtime.turns.steer(conv, opened.session, message);
		},
		templates: () => [],
		selfId: () => runtime.activeConversationId(),
	});

	return {
		registry,
		toolFor: (conversationId) => createSubagentTool(host, conversationId),
		settle: (conversationId, outcome, error) => {
			const conv = runtime.registry.get(conversationId);
			if (!conv || !isSubagent(conv)) return;
			registry.settle(conversationId, error ? { state: outcome, error } : { state: outcome });
		},
	};
}
