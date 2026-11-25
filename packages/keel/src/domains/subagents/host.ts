import type { SettleWakeReason } from "../../subagent-settle.js";
import type { SubagentSpawnExtra } from "../../subagent-security-gate.js";
import type { SubagentSnapshot, SubagentToolHost } from "../../subagents.js";
import type { SettleWaitResult, SubagentRegistry } from "./registry.js";

/** 老宿主那串位置参数在这里合成一个对象：漏传任何一项（persist / thinking / isolation / extra）都是静默丢行为。 */
export interface SubagentSpawnSpec {
	prompt: string;
	type: string;
	cwd: string;
	templateName?: string;
	model?: string;
	parentId?: string;
	persist?: boolean;
	thinking?: string;
	notifyOnDone?: boolean | "manual";
	isolation?: string;
	extra?: SubagentSpawnExtra;
	signal?: AbortSignal;
}

/** 模板清单的一行：与设置帧 `subagentTemplates` 同一份数据（叶子只展示这几列）。 */
export interface SubagentTemplateInfo {
	name: string;
	description: string;
	descriptionEn?: string;
	model?: string;
	thinkingLevel?: string;
}

export type SubagentScope = "all" | "subagent" | "persistent";

/**
 * 快照源：账本（`registry`）只有账本字段，转录/输出/用量归会话投影，所以快照得单独注入。
 * `get` 必须同时认对话 id 与执行身份（老树 `getSubagent` 同口径）：工具两处都会传。
 */
export interface SubagentSnapshotSource {
	get(id: string): SubagentSnapshot | undefined;
	list(scope?: SubagentScope): SubagentSnapshot[];
}

export interface SubagentHostInput {
	/** 结算等待单源：谁在跑、什么时候收口只听账本的。 */
	registry: SubagentRegistry;
	snapshots: SubagentSnapshotSource;
	spawn: (spec: SubagentSpawnSpec) => Promise<string>;
	stop: (id: string) => Promise<void>;
	steer: (id: string, message: string) => Promise<void>;
	templates: () => SubagentTemplateInfo[];
	/** 注入但当前没有消费者：本文件实现的成员都不计时（账本自带 `now`）——保留是因为任务规格要求这个入参。 */
	now: () => number;
	/** 宿主所绑定的对话：派发缺省父级、`getActiveConversationId` 都只认它。 */
	selfId?: () => string | undefined;
}

export class SubagentHostUnsupportedError extends Error {
	readonly member: string;

	constructor(member: string) {
		super(`SubagentToolHost member "${member}" is not implemented by the subagents domain host.`);
		this.name = "SubagentHostUnsupportedError";
		this.member = member;
	}
}

/** 拒绝而不是同步抛：叶子工具在若干回落路径上对返回的 promise 挂 `.catch`，同步抛会绕过它的降级。 */
function unsupported(member: string): Promise<never> {
	return Promise.reject(new SubagentHostUnsupportedError(member));
}

export function createSubagentToolHost(input: SubagentHostInput): SubagentToolHost {
	const parentIdOf = (snapshot: SubagentSnapshot): string | undefined =>
		snapshot.executionId ? (snapshot.parentExecutionId ?? snapshot.parentId) : snapshot.parentId;

	/** 命令面按对话 id 说话（老树 `subagentCurrentId` 同口径）：工具传下来的是执行身份，先归一。 */
	const convIdOf = (id: string): string => input.snapshots.get(id)?.convId ?? id;

	const belongsTo = (forSelfId: string): ((snapshot: SubagentSnapshot) => boolean) => {
		const index = new Map<string, SubagentSnapshot>();
		for (const snapshot of input.snapshots.list()) {
			index.set(snapshot.convId, snapshot);
			if (snapshot.executionId) index.set(snapshot.executionId, snapshot);
		}
		return (snapshot) => {
			const seen = new Set<string>([snapshot.convId]);
			let parentId = parentIdOf(snapshot);
			while (parentId) {
				if (parentId === forSelfId) return true;
				const parent = index.get(parentId);
				if (!parent) return false;
				if (parent.convId === forSelfId || parent.executionId === forSelfId) return true;
				if (seen.has(parent.convId)) return false;
				seen.add(parent.convId);
				parentId = parentIdOf(parent);
			}
			return false;
		};
	};

	// 观测类成员（pending consults / 请示改投 / 消费标记 / worktree 收尾 / 看门狗 / 语言）刻意留空：
	// 它们的缺失在叶子工具里都有明确回落（本宿主没有请示通道、不持有 worktree、不算等待预算），
	// 摆一个会拒绝的桩只会毒化 wait_all 这类已实现的动作；真动作类成员则在下面逐个响亮拒绝。
	return {
		spawnSubagent: (
			prompt,
			type,
			cwd,
			templateName,
			model,
			parentId,
			persist,
			thinking,
			notifyOnDone,
			isolation,
			extra,
			signal,
		) =>
			input.spawn({
				prompt,
				type,
				cwd,
				templateName,
				model,
				parentId: parentId ?? input.selfId?.(),
				persist,
				thinking,
				notifyOnDone,
				isolation,
				extra,
				signal,
			}),
		getSubagent: (convId) => input.snapshots.get(convId),
		listSubagents: (scope, forSelfId) => {
			const snapshots = input.snapshots.list(scope);
			return forSelfId ? snapshots.filter(belongsTo(forSelfId)) : snapshots;
		},
		steerSubagent: (convId, message) => input.steer(convIdOf(convId), message),
		stopSubagent: (convId) => input.stop(convIdOf(convId)),
		waitForSubagentSettle: async (ids, opts) => wakeReasonOf(await input.registry.waitForSettle(ids, opts)),
		listTemplates: () => input.templates(),
		isTemplateUsable: (name) => input.templates().some((template) => template.name === name),
		getActiveConversationId: () => input.selfId?.(),
		completeSubagent: () => unsupported("completeSubagent"),
		listLedgerRuns: () => unsupported("listLedgerRuns"),
		getLedgerRun: () => unsupported("getLedgerRun"),
		getLedgerEvents: () => unsupported("getLedgerEvents"),
		resumeLedgerRun: () => unsupported("resumeLedgerRun"),
		consultParent: () => unsupported("consultParent"),
		answerConsult: () => unsupported("answerConsult"),
		escalateConsult: () => unsupported("escalateConsult"),
		handoffSubagent: () => unsupported("handoffSubagent"),
		dismissSubagent: () => unsupported("dismissSubagent"),
	};
}

/** 账本的四个出口里 `settled` 就是工具侧的「有变化」，其余两个同名直译。 */
function wakeReasonOf(result: SettleWaitResult): SettleWakeReason {
	return result.reason === "settled" ? "changed" : result.reason;
}
