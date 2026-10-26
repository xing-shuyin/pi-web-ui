// ---------------------------------------------------------------------------
// subagents.ts — 第一方轻量子代理：工具定义与运行态模型
// ---------------------------------------------------------------------------
// 架构（相对参考项目的大幅简化）：
//
// 参考项目（tintinweb / nicobailon 的 pi-subagents）把子代理做成「完整子会话」
// —— 独立 SessionManager / SettingsManager / 模型 / 工具隔离 / resume /
// steer / 并发池 / 工作区隔离，复杂度来自「要独立支撑一个完整会话」。
//
// pi-web-ui 的 ClientSession 天生就是多会话并发的：一个 conversation 就有
// 一个独立 AgentSessionRuntime + TerminalManager，所有 conversation 共享
// 同一个 modelRuntime，创建走 createAgentSessionServices + FromServices（已
// 封装好）。因此本模块把子代理定义为：
//
//   子代理 = 一个标记了 isSubagent 的普通 Conversation（inMemory session，
//   不落盘、不进历史/resume 列表）
//   - 出现在左栏「运行的对话」列表，带「子代理」徽标
//   - 用户可以像普通对话一样：点开查看实时消息流、输入补充（= steer）、
//     中止（= abort）、完成后移出（= dismiss）
//   - 运行态经现有快照/消息管线推送，不需要单独的可视化桥
//
// 本文件只定义：运行态快照类型、host 接口（由 ClientSession 实现，操作的是
// 它的 conversation 体系）、以及注册给每个会话的 subagent_* 工具。真正创建
// conversation / 跑 prompt 全部在 agent-service.ts 的 spawnSubagent 里完成。
//
// 返回文本按 lang 取 pick(lang, zh, en)。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { type SubagentSpawnExtra, resolveSecurityMode } from "./subagent-security-gate.js";
import { THINKING_LEVELS } from "./subagent-templates.js";

/** 子代理的状态（由 conversation 派生的轻量视图）。 */
export type SubagentState = "running" | "queued" | "done" | "canceled";

/**
 * subagent_wait_all 的最长阻塞时间：必须短暂低于工具看门狗（默认 20 分钟，
 * PI_WEB_TOOL_TIMEOUT_MS 可调），否则看门狗会先中止整个会话而不是让 wait
 * 干净地超时返回。取 0.8×看门狗（默认 ~16min，支持 PI_WEB_SUBAGENT_WAIT_CAP_SECONDS 覆盖），
 * 兜底不低于 5s。
 */
export function computeWaitCapMs(watchdogMs?: number): number {
	const customSecs = Number(process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS);
	if (Number.isFinite(customSecs) && customSecs > 0) {
		return Math.max(Math.floor(customSecs * 1000), 5_000);
	}
	const envWatchdog = Number(process.env.PI_WEB_TOOL_TIMEOUT_MS);
	const watchdog =
		typeof watchdogMs === "number" && Number.isFinite(watchdogMs) && watchdogMs > 0
			? watchdogMs
			: Number.isFinite(envWatchdog) && envWatchdog > 0
				? envWatchdog
				: 20 * 60_000;
	return Math.max(Math.floor(watchdog * 0.8), 5_000);
}

/** 子代理是否已到终态（运行结束、被中止或出错）。wait 工具据此判断
 * 是否可以取结果；streaming=false 即可（error/canceled 都在快照里带标记）。 */
export function isSubagentTerminal(r: SubagentSnapshot | undefined): boolean {
	return !!r && !r.streaming;
}

/** 单个子代理的运行态快照（供 subagent_list / subagent_get_result 与左栏徽标）。 */
export interface SubagentSnapshot {
	/** conversation id（= 工具的 runId；左栏点击即 switch 到它）。 */
	convId: string;
	/** 展示类型 / 角色（explore / implement / review …，默认 general）。 */
	type: string;
	/** 标题：prompt 首行（截断）。 */
	title: string;
	/** 原始 prompt。 */
	prompt: string;
	state: SubagentState;
	/** 是否正在流式输出。 */
	streaming: boolean;
	/** 最近一次运行是否报错（provider 400/超时等）；有则这里带可读错误文本。 */
	error?: string;
	/** 是否被用户/AI 中止（最后一条 assistant 消息 stopReason=aborted，或中断后
	 *  有输出但未正常结束）。区别于 error：中止不是故障，但不应当作成功结果。 */
	canceled?: boolean;
	/** 会话消息数（近似活动量）。 */
	messageCount: number;
	/** 会话模型 id（可空）。 */
	model?: string;
	/** 会话思考强度（可空）。 */
	thinkingLevel?: string;
	/** 已收集的 assistant 最后文本（运行中为最新输出）。 */
	output: string;
	/** 父对话 id（派发者会话；主对话派发时为普通对话 id，子代理嵌套派发时为父子代理 id）。
	 *  wait_all 据此算后代/祖先，避免子代理无参等待把父级圈进来导致父子互等到超时。 */
	parentId?: string;
	/** 是否为持久化会话（落盘到 session 文件，非仅内存会话）。 */
	persisted?: boolean;
	/** 同行协作交接给的目标子代理 convId 列表（该子代理交接给谁）。 */
	handoffTo?: string[];
	/** 同行协作接收自的来源子代理 convId 列表（谁交接给该子代理）。 */
	handoffFrom?: string[];
	/** 工作树隔离运行态快照（若启用 isolation="worktree"）。 */
	worktree?: {
		path: string;
		branch: string;
		cleanedUp: boolean;
		isDirty?: boolean;
		uncommittedCount?: number;
		aheadCount?: number;
		error?: string;
	};
}

/**
 * 由 ClientSession 实现的子代理操作接口。所有操作都作用于它的
 * conversation 体系（convs.map 里的 isSubagent 对话）。
 */
export interface SubagentToolHost {
	/** 创建子代理 conversation 并触发 prompt。`templateName` 可选：设置面板配置
	 *  的子代理模板（角色 prompt + 技能/扩展白名单 + 可选模型 + 可选思考强度）；
	 *  不传 = 按主会话默认配置。`model` 可选："provider/id"，显式指定本次子代理模型
	 *  （优先级高于模板与设置面板的默认模型）；不传 = 依次回退到模板模型 → 设置面板
	 *  默认模型 → 跟随主对话当前模型。思考强度同理：模板自带优先（不传没有单独的
	 *  thinking 参数）→ 不指定则跟随主对话当前强度。
	 *  `parentId` 可选：真正的派发者对话 id（左栏嵌套用）。按会话归属的 host
	 *  包装会自动填入；不传时回退到派发时刻的 active 对话（兼容旧行为）。
	 *  `persist` 可选：是否创建为持久化落盘的普通对话（存入历史，可继续聊）；
	 *  默认 false（轻量内存子代理）。
	 *  模板不存在/已停用时应抛错（工具把错误转给 AI 而不是启动。）。 */
	spawnSubagent(
		prompt: string,
		type: string,
		cwd: string,
		templateName?: string,
		model?: string,
		parentId?: string,
		persist?: boolean,
		thinking?: string,
		notifyOnDone?: boolean,
		isolation?: string,
		extra?: SubagentSpawnExtra,
	): Promise<string>;
	/** 取单个子代理快照（按 convId）。 */
	getSubagent(convId: string): SubagentSnapshot | undefined;
	/** 列出现有的子代理与派生的受控对话（按创建顺序）。scope: all（默认）/ subagent / persistent。
	 *  `forSelfId`（可选，B20）：调用者自身对话 id。传了才把「祖先链能走到它」的
	 *  会话外子代理一并列出（过户把整族搬去别的 ClientSession 后，wait_all/list
	 *  仍能看到它们）；不传 = 只列本会话自己的（保持原语义与 list 的展示口径）。 */
	listSubagents(scope?: "all" | "subagent" | "persistent", forSelfId?: string): SubagentSnapshot[];
	/** 向运行中的子代理注入消息（未在运行的内容直接排队为下一次回合）。 */
	steerSubagent(convId: string, message: string): Promise<void>;
	/** 中止运行中的子代理。 */
	stopSubagent(convId: string): Promise<void>;
	/** 列出可供 AI 选择的子代理模板（名 + 简介 + 模型 + 思考强度）。只含 enabled 的（停用的对 AI 不可见）。 */
	listTemplates(): {
		name: string;
		description: string;
		descriptionEn?: string;
		model?: string;
		thinkingLevel?: string;
	}[];
	/** 获取当前生效的工具看门狗超时（毫秒），用于计算 wait_all 的最大等待上限。 */
	getWatchdogTimeoutMs?(): number;
	/** 获取当前激活的会话 ID（防止误删前端正在查看的会话）。 */
	getActiveConversationId?(): string | undefined;
	/** 移出子代理会话（释放内存运行时、临时目录与左栏展示）。 */
	dismissSubagent?(
		convId: string,
		opts?: { force?: boolean; includePersisted?: boolean },
	): Promise<{ ok: boolean; reason?: string }>;
	/** 检查某个模板名是否可用于派生子代理（存在且 enabled）。 */
	isTemplateUsable(name: string): boolean;
	/** 将任务产物或指令从一个子代理直接交接给另一个同行子代理（对等协作路由）。 */
	handoffSubagent(fromRunId: string, toRunId: string, payload: string): Promise<void>;
	/** 标记指定子代理已被父会话消费（通过 wait_all 或 get_result），后续避免重复发送终态通知。 */
	markSubagentsConsumed?(runIds: string[]): void;
	/** 终态结算与清理子代理的工作树（若启用了工作树隔离）。 */
	finalizeSubagentWorktree?(convId: string): Promise<void>;
	/** 可选语言（主会话按客户端 locale 提供 getLang；缺省英文）。 */
	lang?: () => ServerLang;
}

/** 从 prompt 取首行作为标题（截断 40 字符）。 */
export function subagentTitle(prompt: string): string {
	const line = prompt.split("\n")[0]?.trim() ?? "";
	return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/**
 * 返回注入 ownerId 的 host 包装：每次 spawn 时自动把 ownerId（真正的派发会话）
 * 作为子代理的 parentId 传给底层 host。
 *
 * 背景（issue #95）：子代理左栏嵌套靠 parentId，而派发方是某个会话的 runtime ——
 * 必须按 runtime 归属记父对话，而不是派发瞬间的 active。后台对话继续产出时用户
 * 可能已切到别的项目，直接读 activeId 会把孩子记到无关会话名下（错组/沉底）。
 * 每个会话创建 runtime 时用本函数包一层，让它的 spawn 天然带自己的会话 id。
 */
export function withSubagentOwner(host: SubagentToolHost, ownerId: string): SubagentToolHost {
	return {
		...host,
		spawnSubagent: (
			prompt,
			type,
			cwd,
			templateName,
			model,
			_parentId,
			persist,
			thinking,
			notifyOnDone,
			isolation,
			extra,
		) => {
			const args: unknown[] = [prompt, type, cwd, templateName, model, ownerId, persist, thinking, notifyOnDone];
			if (isolation !== undefined || extra !== undefined) {
				args.push(isolation);
			}
			if (extra !== undefined) {
				args.push(extra);
			}
			return host.spawnSubagent(...(args as Parameters<SubagentToolHost["spawnSubagent"]>));
		},
		handoffSubagent: (fromRunId, toRunId, payload) => host.handoffSubagent(fromRunId || ownerId, toRunId, payload),
		markSubagentsConsumed: (runIds) => host.markSubagentsConsumed?.(runIds),
		finalizeSubagentWorktree: (convId) => host.finalizeSubagentWorktree?.(convId) ?? Promise.resolve(),
		getActiveConversationId: () => host.getActiveConversationId?.(),
		dismissSubagent: (convId, opts) =>
			host.dismissSubagent?.(convId, opts) ?? Promise.resolve({ ok: false, reason: "unsupported" }),
	};
}

export const SUBAGENT_TOOL_NAME = "subagent";

export const SUBAGENT_ACTIONS = [
	"spawn",
	"get_result",
	"steer",
	"list",
	"stop",
	"wait_all",
	"templates",
	"handoff",
	"dismiss",
] as const;

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

/**
 * 单 action 子代理总工具（注册进每个会话的 customTools，供主 agent 驱动子代理）。
 * 合并原 subagent_* 8 个工具为一个统一入口，节省会话上下文 token。
 *
 * `selfConvId`（可选）：这套工具所注册进的会话 convId。`wait_all`
 * 永远排除调用者自身——子代理会话上同样注册了该工具，不传 runIds 时
 * 「全部」会含它自己，而它正在执行本工具（streaming=true），不排除就是
 * 自己等自己、永远到超时（self-wait deadlock）。主会话调用时传它自己的
 * 普通对话 id 即可（不在子代理列表里，delete 是 no-op）。
 */
export function makeSubagentTool(
	host: SubagentToolHost,
	lang?: () => ServerLang,
	selfConvId?: string | (() => string | undefined),
): ToolDefinition {
	// B20：过户会把对话改名（撞 id 时 remap），自省 id 必须在调用时刻解析
	// （按 runtime 身份查当前持有方），不能死用建时的旧 id —— 否则 wait_all
	// 排除自省/展开后代时拿错锚点。传函数形式由建时点按 findConversationHome 解析。
	const selfIdOf = (): string | undefined => (typeof selfConvId === "function" ? selfConvId() : selfConvId);
	const getLang: () => ServerLang = lang ?? host.lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});

	const expandDescendants = (roots: Set<string> | string[]): string[] => {
		if (roots instanceof Set ? roots.size === 0 : (roots as string[]).length === 0) return [];
		const rootSet = roots instanceof Set ? roots : new Set(roots);
		// B20：带 forSelfId（本会话的族）展开 —— 过户把整族搬到别的会话后，
		// 只列本会话自己的列表会展不开后代，wait_all 会误报「没有需要等待的子代理」。
		const all = host.listSubagents(undefined, selfIdOf());
		const out: string[] = [];
		for (const s of all) {
			if (rootSet.has(s.convId)) continue;
			let curParent = s.parentId;
			const seen = new Set<string>();
			while (curParent) {
				if (rootSet.has(curParent)) {
					out.push(s.convId);
					break;
				}
				if (seen.has(curParent)) break;
				seen.add(curParent);
				curParent = host.getSubagent(curParent)?.parentId;
			}
		}
		return out;
	};

	const isDescendantOf = (targetId: string, rootId: string): boolean => {
		const target = host.getSubagent(targetId);
		if (!target) return false;
		let curParent = target.parentId;
		const seen = new Set<string>([targetId]);
		while (curParent) {
			if (curParent === rootId) return true;
			if (seen.has(curParent)) break;
			seen.add(curParent);
			curParent = host.getSubagent(curParent)?.parentId;
		}
		return false;
	};

	const depthOf = (targetId: string): number => {
		let d = 0;
		let cur = host.getSubagent(targetId);
		const seen = new Set<string>([targetId]);
		while (cur?.parentId) {
			if (seen.has(cur.parentId)) break;
			seen.add(cur.parentId);
			d++;
			cur = host.getSubagent(cur.parentId);
			if (!cur) break;
		}
		return d;
	};

	const currentWaitCapMs =
		typeof host.getWatchdogTimeoutMs === "function"
			? computeWaitCapMs(host.getWatchdogTimeoutMs())
			: computeWaitCapMs();
	const capSeconds = Math.floor(currentWaitCapMs / 1000);

	return defineTool({
		name: SUBAGENT_TOOL_NAME,
		label: "Subagent manager",
		description:
			"Manage background subagent conversations for parallel delegation, research, and execution. " +
			"Each action's arguments are documented on the parameters below.",
		promptSnippet: "manage background subagents (spawn/steer/wait/dismiss)",
		parameters: Type.Object({
			action: Type.Unsafe<SubagentAction>({
				type: "string",
				enum: [...SUBAGENT_ACTIONS],
				description: "The subagent action to perform.",
			}),
			prompt: Type.Optional(
				Type.String({
					description: "spawn: instructions (goal, constraints, expected output).",
				}),
			),
			runId: Type.Optional(
				Type.String({
					description: "get_result/steer/stop/dismiss: target conversation ID.",
				}),
			),
			runIds: Type.Optional(
				Type.Array(Type.String(), {
					description: "wait_all/dismiss: conversation IDs to wait for or dismiss.",
				}),
			),
			message: Type.Optional(
				Type.String({
					description: "steer: follow-up instruction.",
				}),
			),
			payload: Type.Optional(
				Type.String({
					description: "handoff: what to transfer to the peer.",
				}),
			),
			toRunId: Type.Optional(
				Type.String({
					description: "handoff: target peer ID.",
				}),
			),
			fromRunId: Type.Optional(
				Type.String({
					description: "handoff: source ID (default = this subagent).",
				}),
			),
			type: Type.Optional(
				Type.String({
					description:
						"spawn: role/type (e.g. explore/implement/review, default: general). When matching a template name, the template and its security profile (e.g. readonly for explore, verify for review) are automatically applied.",
				}),
			),
			template: Type.Optional(
				Type.String({
					description: "spawn: template name (see action=templates).",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: 'spawn: model override "provider/id".',
				}),
			),
			thinking: Type.Optional(
				Type.String({
					enum: [...THINKING_LEVELS],
					description:
						'spawn: thinking budget level ("off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max").',
				}),
			),
			notifyOnDone: Type.Optional(
				Type.Boolean({
					description: "spawn: notify and wake parent conversation when finished (default: true).",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description: "spawn: working directory (default = current).",
				}),
			),
			persist: Type.Optional(
				Type.Boolean({
					description: "spawn: persist as a regular session (default = ephemeral).",
				}),
			),
			isolation: Type.Optional(
				Type.String({
					enum: ["worktree", "none"],
					description:
						'spawn: workspace isolation mode ("worktree" creates a dedicated git worktree & branch; "none" = shared cwd).',
				}),
			),
			kind: Type.Optional(
				Type.String({
					enum: ["all", "subagent", "persistent"],
					description: "list: filter subagents by kind (default: all).",
				}),
			),
			timeoutSeconds: Type.Optional(
				Type.Integer({
					description: `wait_all: max wait in seconds (default: ${capSeconds}s).`,
					minimum: 1,
					maximum: capSeconds,
				}),
			),
			scope: Type.Optional(
				Type.String({
					enum: ["finished_all"],
					description: 'dismiss: batch dismissal scope ("finished_all" to dismiss all finished descendant subagents).',
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description: "dismiss: force abort running subagents before dismissing (default: false).",
				}),
			),
			includePersisted: Type.Optional(
				Type.Boolean({
					description: "dismiss: allow dismissing persisted subagents (default: false).",
				}),
			),
		}),
		execute: async (_id, p, signal, _onUpdate, ctx) => {
			const action = (p.action ?? "").trim().toLowerCase();
			if (!action) {
				return text(
					pick(
						getLang(),
						"subagent 工具缺少 action 参数（可选：spawn, get_result, steer, list, stop, wait_all, templates, handoff, dismiss）。",
						"subagent tool requires an action parameter (one of: spawn, get_result, steer, list, stop, wait_all, templates, handoff, dismiss).",
						"subagents.action.missing",
					),
				);
			}

			switch (action) {
				case "spawn": {
					if (!p.prompt || typeof p.prompt !== "string" || !p.prompt.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="spawn") 缺少 prompt 参数。',
								'subagent(action="spawn") requires prompt parameter.',
								"subagents.spawn.missing.prompt",
							),
						);
					}
					let templateName: string | undefined;
					if (p.template) {
						if (!host.isTemplateUsable(p.template)) {
							return text(
								pick(
									getLang(),
									`子代理模板不可用：${p.template}（不存在或已停用）。用 subagent(action="templates") 查看当前可用模板清单；不传 template 则按默认配置运行。`,
									`Subagent template unavailable: ${p.template} (missing or disabled). Use subagent(action="templates") to list available templates; omit template to run with defaults.`,
									"subagents.spawn.template.unavailable",
									{ "p.template": p.template },
								),
							);
						}
						templateName = p.template.trim();
					} else if (p.type && typeof p.type === "string" && host.isTemplateUsable(p.type.trim())) {
						templateName = p.type.trim();
					}
					if (p.thinking && !THINKING_LEVELS.includes(p.thinking as (typeof THINKING_LEVELS)[number])) {
						return text(
							pick(
								getLang(),
								`非法思考强度：${p.thinking}。可选档位：${THINKING_LEVELS.join(", ")}。`,
								`Invalid thinking level: ${p.thinking}. Allowed levels: ${THINKING_LEVELS.join(", ")}.`,
								"subagents.spawn.thinking.invalid",
								{ thinking: p.thinking, levels: THINKING_LEVELS.join(", ") },
							),
						);
					}
					const isolationMode = p.isolation?.trim().toLowerCase();
					if (isolationMode && isolationMode !== "worktree" && isolationMode !== "none") {
						return text(
							pick(
								getLang(),
								`不支持的隔离模式：${p.isolation}。可选模式："worktree"（基于 Git 工作树物理隔离）或 "none"（默认共享工作区）。`,
								`Unsupported isolation mode: ${p.isolation}. Supported modes: "worktree" (git worktree isolation) or "none" (shared workspace).`,
								"subagents.spawn.isolation.invalid",
								{ isolation: p.isolation },
							),
						);
					}
					let convId: string;
					const subagentType = p.type ?? "general";
					const matchedTemplate = templateName ? host.listTemplates().find((t) => t.name === templateName) : undefined;
					const securityMode = resolveSecurityMode(subagentType, matchedTemplate);
					const extra: SubagentSpawnExtra | undefined = securityMode !== "normal" ? { securityMode } : undefined;

					try {
						const spawnArgs: [
							string,
							string,
							string,
							string?,
							string?,
							string?,
							boolean?,
							string?,
							boolean?,
							string?,
							SubagentSpawnExtra?,
						] = [
							p.prompt,
							subagentType,
							p.cwd ?? ctx.cwd,
							templateName,
							p.model,
							undefined,
							p.persist,
							p.thinking,
							p.notifyOnDone,
						];
						if (isolationMode === "worktree" || extra !== undefined) {
							spawnArgs.push(isolationMode === "worktree" ? "worktree" : undefined);
						}
						if (extra !== undefined) {
							spawnArgs.push(extra);
						}
						convId = await host.spawnSubagent(...spawnArgs);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return text(
							pick(getLang(), `子代理启动失败：${msg}`, `Failed to start subagent: ${msg}`, "subagents.spawn.failed", {
								error: msg,
							}),
						);
					}
					const subagentTitleText = subagentTitle(p.prompt);
					const templateLineZh = templateName ? `\n模板：${templateName}` : "";
					const templateLineEn = templateName ? `\nTemplate: ${templateName}` : "";
					const modelLineZh = p.model ? `\n模型：${p.model}` : "";
					const modelLineEn = p.model ? `\nModel: ${p.model}` : "";
					const thinkingLineZh = p.thinking ? `\n思考强度：${p.thinking}` : "";
					const thinkingLineEn = p.thinking ? `\nThinking: ${p.thinking}` : "";
					const notifyLineZh = p.notifyOnDone === false ? "\n自动通知：已关闭" : "";
					const notifyLineEn = p.notifyOnDone === false ? "\nAuto-notify: disabled" : "";
					const isolationLineZh = isolationMode === "worktree" ? "\n工作树隔离：已启用（独立 Git 工作树与分支）" : "";
					const isolationLineEn =
						isolationMode === "worktree" ? "\nWorktree isolation: enabled (dedicated Git worktree & branch)" : "";
					const kindLabelZh = p.persist ? "普通持久化对话" : "子代理";
					const kindLabelEn = p.persist ? "Persistent conversation" : "Subagent";
					return text(
						pick(
							getLang(),
							`${kindLabelZh}已启动（运行列表可见）：${convId}\n类型：${subagentType} · 标题：${subagentTitleText}${templateLineZh}${modelLineZh}${thinkingLineZh}${notifyLineZh}${isolationLineZh}` +
								`\n用 subagent(action="wait_all") 一次等全部完成（不用轮询），subagent(action="get_result") 取单个结果，subagent(action="list") 看运行态，subagent(action="steer") 改向，subagent(action="stop") 停止。`,
							`${kindLabelEn} started (visible in the running list): ${convId}\nType: ${subagentType} · Title: ${subagentTitleText}${templateLineEn}${modelLineEn}${thinkingLineEn}${notifyLineEn}${isolationLineEn}` +
								`\nUse subagent(action="wait_all") to wait for all at once (no polling), subagent(action="get_result") for a single result, subagent(action="list") for live status, subagent(action="steer") to redirect, subagent(action="stop") to stop.`,
							"subagents.spawn.started",
							{
								convId,
								subagentType,
								subagentTitleText,
								"p.template": p.template,
								"p.model": p.model,
								"p.thinking": p.thinking,
								templateLineZh,
								templateLineEn,
								modelLineZh,
								modelLineEn,
								thinkingLineZh,
								thinkingLineEn,
								notifyLineZh,
								notifyLineEn,
								isolationLineZh,
								isolationLineEn,
								kindLabel: kindLabelEn,
								kindLabelEn,
								kindLabelZh,
							},
						),
						{
							convId,
							template: p.template,
							model: p.model,
							thinking: p.thinking,
							persisted: !!p.persist,
							notifyOnDone: p.notifyOnDone !== false,
							isolation: isolationMode === "worktree" ? "worktree" : undefined,
						},
					);
				}

				case "get_result": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="get_result") 缺少 runId 参数。',
								'subagent(action="get_result") requires runId parameter.',
								"subagents.get.missing.runId",
							),
						);
					}
					let r = host.getSubagent(p.runId);
					const missingId = shortId(p.runId);
					if (!r)
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingId}（可能已移出）。`,
								`Subagent ${missingId} not found (may have been dismissed).`,
								"subagents.get.not.found",
								{ missingId },
							),
							undefined,
						);
					const verdict = subagentVerdict(r, getLang());
					const doneId = shortId(r.convId);
					const doneDetail = verdictText(r, getLang());
					const doneOutput = r.output || (getLang() === "zh" ? "（无结果）" : "(no result)");
					const modelTag = r.model ? ` · ${r.model}${r.thinkingLevel ? `:${r.thinkingLevel}` : ""}` : "";
					if (r.streaming || r.state === "running") {
						const runningId = shortId(r.convId);
						const runningOutput = r.output || (getLang() === "zh" ? "（暂无输出）" : "(no output yet)");
						return text(
							pick(
								getLang(),
								`子代理 ${runningId}（${r.type}${modelTag}）仍在运行（状态 ${r.state}）。\n当前输出：\n${runningOutput}`,
								`Subagent ${runningId} (${r.type}${modelTag}) is still running (state ${r.state}).\nCurrent output:\n${runningOutput}`,
								"subagents.get.running",
								{ runningId, "r.type": r.type, modelTag, "r.state": r.state, runningOutput },
							),
							r,
						);
					}
					// 终态结果被父对话取走，标记已消费，避免后续重复触发自动通知
					host.markSubagentsConsumed?.([p.runId]);
					if (host.finalizeSubagentWorktree) {
						await host.finalizeSubagentWorktree(p.runId);
						r = host.getSubagent(p.runId) ?? r;
					}
					let worktreeDetail = "";
					if (r.worktree) {
						const wt = r.worktree;
						if (wt.cleanedUp) {
							worktreeDetail = pick(
								getLang(),
								"\n\n[工作树隔离] 无文件修改，临时工作树与分支已自动清理。",
								"\n\n[Worktree isolation] No changes made; temporary worktree and branch have been cleaned up automatically.",
								"subagents.get.worktree.cleaned",
							);
						} else {
							worktreeDetail = pick(
								getLang(),
								`\n\n[工作树隔离] 代码改动已保留供审阅：\n- 路径：${wt.path}\n- 分支：${wt.branch}\n- 改动：${wt.uncommittedCount ?? 0} 个未提交文件修改，领先 ${wt.aheadCount ?? 0} 个提交\n（提示：可执行 git merge ${wt.branch} 合并，或调用 worktree(action="remove", path="${wt.path}", force=true) 放弃）`,
								`\n\n[Worktree isolation] Changes preserved for review:\n- Path: ${wt.path}\n- Branch: ${wt.branch}\n- Changes: ${wt.uncommittedCount ?? 0} uncommitted file(s), ${wt.aheadCount ?? 0} commit(s) ahead\n(Note: run git merge ${wt.branch} to merge, or worktree(action="remove", path="${wt.path}", force=true) to discard)`,
								"subagents.get.worktree.preserved",
								{ path: wt.path, branch: wt.branch, uncommitted: wt.uncommittedCount ?? 0, ahead: wt.aheadCount ?? 0 },
							);
						}
					}
					return text(
						pick(
							getLang(),
							`子代理 ${doneId}（${r.type}${modelTag}）状态：${verdict}\n${doneDetail}\n${doneOutput}${worktreeDetail}`,
							`Subagent ${doneId} (${r.type}${modelTag}) status: ${verdict}\n${doneDetail}\n${doneOutput}${worktreeDetail}`,
							"subagents.get.done",
							{ doneId, "r.type": r.type, modelTag, verdict, doneDetail, doneOutput: `${doneOutput}${worktreeDetail}` },
						),
						r,
					);
				}

				case "steer": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="steer") 缺少 runId 参数。',
								'subagent(action="steer") requires runId parameter.',
								"subagents.steer.missing.runId",
							),
						);
					}
					if (typeof p.message !== "string" || !p.message.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="steer") 缺少 message 参数。',
								'subagent(action="steer") requires message parameter.',
								"subagents.steer.missing.message",
							),
						);
					}
					if (!host.getSubagent(p.runId)) {
						const missingSteerId = shortId(p.runId);
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingSteerId}（可能已移出），消息未注入。请用 subagent(action="list") 确认仍在运行的子代理。`,
								`Subagent ${missingSteerId} not found (may have been dismissed); message not injected. Use subagent(action="list") to confirm running subagents.`,
								"subagents.steer.not.found",
								{ missingSteerId },
							),
						);
					}
					await host.steerSubagent(p.runId, p.message);
					const steerId = shortId(p.runId);
					return text(
						pick(
							getLang(),
							`已向子代理 ${steerId} 注入消息。`,
							`Message injected into subagent ${steerId}.`,
							"subagents.steer.injected",
							{ steerId },
						),
					);
				}

				case "list": {
					const list = host.listSubagents(p.kind as "all" | "subagent" | "persistent" | undefined, selfIdOf());
					if (list.length === 0)
						return text(
							pick(
								getLang(),
								"当前没有运行中的对话/子代理。",
								"No managed conversations or subagents running.",
								"subagents.list.empty",
							),
						);
					const tLang = getLang();
					const lines = list.map((r) => {
						const tag = r.persisted
							? tLang === "zh"
								? "持久化"
								: "persistent"
							: tLang === "zh"
								? "子代理"
								: "subagent";
						const modelTag = r.model ? ` · ${r.model}${r.thinkingLevel ? `:${r.thinkingLevel}` : ""}` : "";
						return (
							`- ${r.convId} · ${r.type}${modelTag} · ${subagentVerdict(r, tLang)} · ${r.title}` +
							(tLang === "zh" ? `（${tag} · msg: ${r.messageCount}）` : ` (${tag} · msg: ${r.messageCount})`)
						);
					});
					return text(lines.join("\n"));
				}

				case "stop": {
					if (!p.runId || typeof p.runId !== "string" || !p.runId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="stop") 缺少 runId 参数。',
								'subagent(action="stop") requires runId parameter.',
								"subagents.stop.missing.runId",
							),
						);
					}
					if (!host.getSubagent(p.runId)) {
						const missingStopId = shortId(p.runId);
						return text(
							pick(
								getLang(),
								`未找到子代理 ${missingStopId}（可能已移出或已结束），无需停止。请用 subagent(action="list") 确认仍在运行的子代理。`,
								`Subagent ${missingStopId} not found (may have been dismissed or already finished); nothing to stop. Use subagent(action="list") to confirm running subagents.`,
								"subagents.stop.not.found",
								{ missingStopId },
							),
						);
					}
					await host.stopSubagent(p.runId);
					const stopId = shortId(p.runId);
					return text(
						pick(
							getLang(),
							`已请求停止子代理 ${stopId}。`,
							`Stop requested for subagent ${stopId}.`,
							"subagents.stop.requested",
							{ stopId },
						),
					);
				}

				case "wait_all": {
					const selfId = selfIdOf();
					const ancestorIdsOf = (selfId: string): Set<string> => {
						const out = new Set<string>();
						const seen = new Set<string>([selfId]);
						let cur = host.getSubagent(selfId)?.parentId;
						while (cur && !seen.has(cur)) {
							seen.add(cur);
							out.add(cur);
							cur = host.getSubagent(cur)?.parentId;
						}
						return out;
					};

					const explicit = p.runIds && p.runIds.length > 0;
					const wanted = new Set<string>();
					const selfAncestorIds = selfId ? ancestorIdsOf(selfId) : new Set<string>();

					if (explicit) {
						const seedRoots: string[] = [];
						for (const id of p.runIds!) {
							if (selfId && id === selfId) continue;
							if (selfAncestorIds.has(id)) continue;
							wanted.add(id);
							seedRoots.push(id);
						}
						for (const descId of expandDescendants(seedRoots)) {
							if (selfId && descId === selfId) continue;
							if (selfAncestorIds.has(descId)) continue;
							wanted.add(descId);
						}
					} else if (selfId) {
						for (const descId of expandDescendants(new Set([selfId]))) {
							if (descId === selfId) continue;
							if (selfAncestorIds.has(descId)) continue;
							wanted.add(descId);
						}
					} else {
						for (const r of host.listSubagents()) {
							wanted.add(r.convId);
						}
					}
					if (selfId) wanted.delete(selfId);
					for (const ancId of selfAncestorIds) wanted.delete(ancId);

					if (wanted.size === 0) {
						return text(
							pick(
								getLang(),
								"没有需要等待的子代理（调用者自身与其祖先永不计入等待；子代理无参数调用时只等待属于它自己的后代）。",
								"No subagents to wait for (the calling session itself and its ancestors are never waited on; a subagent without runIds only waits for its own descendants).",
								"subagents.wait.empty",
							),
						);
					}

					const liveWaitCapMs =
						typeof host.getWatchdogTimeoutMs === "function"
							? computeWaitCapMs(host.getWatchdogTimeoutMs())
							: currentWaitCapMs;
					const liveCapSeconds = Math.floor(liveWaitCapMs / 1000);
					const timeoutMs = Math.min(Math.max(p.timeoutSeconds ?? liveCapSeconds, 1), liveCapSeconds) * 1000;
					const startedAt = Date.now();
					const POLL_INTERVAL_MS = 250;

					while (!signal?.aborted && Date.now() - startedAt < timeoutMs) {
						for (const descId of expandDescendants(wanted)) {
							if (selfId && descId === selfId) continue;
							if (selfAncestorIds.has(descId)) continue;
							wanted.add(descId);
						}
						const allDone = Array.from(wanted).every((id) => {
							const r = host.getSubagent(id);
							// #488：getSubagent 返回 undefined = 已被移出（强行关闭/收尾清理）
							// ——视为终态，与下方报告段「已移出或不存在」口径一致；否则等待
							// 集合含被移出子代理时 allDone 恒 false，必然白等满 timeoutMs。
							return r === undefined || isSubagentTerminal(r);
						});
						if (allDone) break;
						await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
					}

					const tLang = getLang();
					const waitedSecs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
					const timeoutSecs = Math.round(timeoutMs / 1000);

					// 收口的子代理标记已消费，避免后续重复自动通知打扰父对话；同时结算隔离工作树
					const finishedIds = Array.from(wanted).filter((id) => {
						const r = host.getSubagent(id);
						return r === undefined || isSubagentTerminal(r);
					});
					if (finishedIds.length > 0) {
						host.markSubagentsConsumed?.(finishedIds);
						if (host.finalizeSubagentWorktree) {
							await Promise.all(finishedIds.map((id) => host.finalizeSubagentWorktree!(id)));
						}
					}

					const lines = Array.from(wanted)
						.map((id) => {
							const r = host.getSubagent(id);
							const sId = shortId(id);
							if (!r) {
								return pick(
									tLang,
									`- ${sId}：已移出或不存在`,
									`- ${sId}: dismissed or not found`,
									"subagents.wait.item.missing",
									{ sId },
								);
							}
							const verdict = subagentVerdict(r, tLang);
							const detail = verdictText(r, tLang);
							const out = clipSubagentOutput(r.output || (tLang === "zh" ? "（无输出）" : "(no output)"), tLang);
							let wtTag = "";
							let wtPathInfo = "";
							if (r.worktree) {
								if (r.worktree.cleanedUp) {
									wtTag = tLang === "zh" ? " · 工作树已清理" : " · worktree cleaned";
								} else {
									wtTag =
										tLang === "zh"
											? ` · 工作树保留: ${r.worktree.branch} (${r.worktree.uncommittedCount ?? 0} 改动, +${r.worktree.aheadCount ?? 0} 提交)`
											: ` · worktree kept: ${r.worktree.branch} (${r.worktree.uncommittedCount ?? 0} dirty, +${r.worktree.aheadCount ?? 0} commits)`;
									wtPathInfo =
										tLang === "zh" ? `\n  - 工作树路径：${r.worktree.path}` : `\n  - Worktree path: ${r.worktree.path}`;
								}
							}
							return `- ${sId}（${r.type} · ${verdict} · ${r.title}${wtTag}）${detail ? ` · ${detail}` : ""}:\n${out}${wtPathInfo}`;
						})
						.join("\n\n");

					const remaining = Array.from(wanted).filter((id) => {
						const r = host.getSubagent(id);
						return !isSubagentTerminal(r);
					});

					const head =
						remaining.length === 0
							? pick(
									tLang,
									`全部 ${wanted.size} 个子代理已收口：`,
									`All ${wanted.size} subagent(s) collected:`,
									"subagents.wait.collected",
									{ "wanted.size": wanted.size },
								)
							: signal?.aborted
								? pick(
										tLang,
										`本轮被中止，${remaining.length} 个仍在运行：`,
										`This round was aborted, ${remaining.length} still running:`,
										"subagents.wait.aborted",
										{ "remaining.length": remaining.length },
									)
								: pick(
										tLang,
										`等待超过 ${timeoutSecs}s 超时（实际等待 ${waitedSecs}s），${remaining.length} 个仍在运行：`,
										`Wait timed out after ${timeoutSecs}s (actually waited ${waitedSecs}s), ${remaining.length} still running:`,
										"subagents.wait.timeout",
										{ timeoutSecs, waitedSecs, "remaining.length": remaining.length },
									);
					return text(`${head}\n${lines}\n` + promptRemaining(remaining, tLang));
				}

				case "templates": {
					const list = host.listTemplates();
					const tLang = getLang();
					if (list.length === 0) {
						return text(
							pick(
								tLang,
								"当前没有可用的子代理模板（设置面板 → 子代理模板 添加后可用）。子代理默认按主会话配置运行。",
								"No subagent templates available (add some under Settings → Subagent Templates). Subagents run with the main session defaults.",
								"subagents.templates.empty",
							),
						);
					}
					const lines = list.map((t) => {
						const desc = tLang === "zh" ? t.description : t.descriptionEn || t.description;
						const modelPart =
							tLang === "zh"
								? t.model
									? `模型：${t.model}`
									: "跟随主对话模型"
								: t.model
									? `model: ${t.model}`
									: "follows the main conversation model";
						const thinkingPart =
							tLang === "zh"
								? t.thinkingLevel
									? `思考强度：${t.thinkingLevel}`
									: "跟随主对话思考强度"
								: t.thinkingLevel
									? `thinking: ${t.thinkingLevel}`
									: "follows the main conversation thinking level";
						return (
							(tLang === "zh" ? `- ${t.name}${desc ? `：${desc}` : ""}` : `- ${t.name}${desc ? `: ${desc}` : ""}`) +
							(tLang === "zh" ? `（${modelPart}，${thinkingPart}）` : ` (${modelPart}, ${thinkingPart})`)
						);
					});
					const firstTemplateName = list[0]?.name;
					const templateLines = lines.join("\n");
					return text(
						pick(
							getLang(),
							`可用的子代理模板（subagent 的 template 参数传名字，如 subagent(action="spawn", template="${firstTemplateName}"))：\n${templateLines}`,
							`Available subagent templates (pass the name as subagent's template param, e.g. subagent(action="spawn", template="${firstTemplateName}")):\n${templateLines}`,
							"subagents.templates.list",
							{ firstTemplateName, templateLines },
						),
					);
				}

				case "handoff": {
					const fromId = p.fromRunId || selfIdOf() || "unknown";
					if (!p.toRunId || typeof p.toRunId !== "string" || !p.toRunId.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="handoff") 缺少 toRunId 参数。',
								'subagent(action="handoff") requires toRunId parameter.',
								"subagents.handoff.missing.toRunId",
							),
						);
					}
					if (typeof p.payload !== "string" || !p.payload.trim()) {
						return text(
							pick(
								getLang(),
								'subagent(action="handoff") 缺少 payload 参数。',
								'subagent(action="handoff") requires payload parameter.',
								"subagents.handoff.missing.payload",
							),
						);
					}
					if (fromId === p.toRunId) {
						return text(
							pick(
								getLang(),
								`交接失败：不能交接给自身（${shortId(fromId)}）。请指定其他同行子代理。`,
								`Handoff failed: cannot hand off to oneself (${shortId(fromId)}). Please specify a different peer subagent.`,
								"subagents.handoff.self",
								{ id: shortId(fromId) },
							),
						);
					}
					const target = host.getSubagent(p.toRunId);
					if (!target) {
						const missingId = shortId(p.toRunId);
						return text(
							pick(
								getLang(),
								`未找到目标子代理 ${missingId}（可能已移出或不存在）。请用 subagent(action="list") 确认可用的子代理。`,
								`Target subagent ${missingId} not found (may have been dismissed or non-existent). Use subagent(action="list") to check available subagents.`,
								"subagents.handoff.not.found",
								{ missingId },
							),
						);
					}

					try {
						await host.handoffSubagent(fromId, p.toRunId, p.payload);
						const fromShort = shortId(fromId);
						const toShort = shortId(p.toRunId);
						return text(
							pick(
								getLang(),
								`已成功将产物交接给同行子代理 ${toShort}（${target.type}），协同路由已建立并开始执行。`,
								`Successfully handed off payload to peer subagent ${toShort} (${target.type}); peer routing established and executing.`,
								"subagents.handoff.success",
								{ from: fromShort, to: toShort, type: target.type },
							),
							{ fromRunId: fromId, toRunId: p.toRunId, timestamp: Date.now() },
						);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return text(
							pick(getLang(), `交接失败：${msg}`, `Handoff failed: ${msg}`, "subagents.handoff.failed", { error: msg }),
						);
					}
				}

				case "dismiss": {
					if (!host.dismissSubagent) {
						return text(
							pick(
								getLang(),
								"当前引擎不支持子代理移出能力。",
								"Subagent dismissal is not supported by the current engine.",
								"subagents.dismiss.unsupported",
							),
						);
					}

					const explicitIds: string[] = [];
					if (Array.isArray(p.runIds) && p.runIds.length > 0) {
						for (const id of p.runIds) {
							if (typeof id === "string" && id.trim()) {
								explicitIds.push(id.trim());
							}
						}
					} else if (p.runId && typeof p.runId === "string" && p.runId.trim()) {
						explicitIds.push(p.runId.trim());
					}

					const isFinishedAll = p.scope === "finished_all";

					if (explicitIds.length === 0 && !isFinishedAll) {
						return text(
							pick(
								getLang(),
								'subagent(action="dismiss") 缺少目标参数：请指定 runId、runIds 或 scope="finished_all"。',
								'subagent(action="dismiss") requires target parameter: specify runId, runIds, or scope="finished_all".',
								"subagents.dismiss.missing.target",
							),
						);
					}

					const selfId = selfIdOf();
					const activeConvId = host.getActiveConversationId?.();

					let candidateIds: string[] = [];
					if (isFinishedAll) {
						const all = host.listSubagents(undefined, selfId);
						let inScopeList = all;
						if (selfId) {
							const descIds = new Set(expandDescendants(new Set([selfId])));
							inScopeList = all.filter((s) => descIds.has(s.convId));
						}
						// 口径与 finishedSubagentCount 一致：isSubagent、非 streaming、非当前 active
						candidateIds = inScopeList
							.filter((s) => {
								if (s.streaming || s.state === "running") return false;
								if (s.convId === selfId) return false;
								if (activeConvId && s.convId === activeConvId) return false;
								if (s.persisted && !p.includePersisted) return false;
								return true;
							})
							.map((s) => s.convId);

						if (candidateIds.length === 0) {
							return text(
								pick(
									getLang(),
									"没有可移出的已结束子代理。",
									"No finished subagents to dismiss.",
									"subagents.dismiss.finished_all.empty",
								),
								{ dismissed: [], skipped: [] },
							);
						}
					} else {
						candidateIds = [...new Set(explicitIds)];
					}

					const isSingleExplicit = !isFinishedAll && explicitIds.length === 1;
					if (isSingleExplicit) {
						const targetId = candidateIds[0];
						const snapshot = host.getSubagent(targetId);
						if (!snapshot) {
							const missingId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`未找到子代理 ${missingId}（可能已移出或不存在）。`,
									`Subagent ${missingId} not found (may have been dismissed or non-existent).`,
									"subagents.dismiss.not_found",
									{ missingId },
								),
							);
						}
						if (selfId && targetId === selfId) {
							return text(
								pick(
									getLang(),
									"拒绝移出：不能移出当前会话自身。",
									"Refused: cannot dismiss the current conversation itself.",
									"subagents.dismiss.self",
								),
							);
						}
						if (activeConvId && targetId === activeConvId) {
							const activeId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`子代理 ${activeId} 正在前端处于活动打开状态，无法直接移出。`,
									`Subagent ${activeId} is currently active in the UI and cannot be dismissed.`,
									"subagents.dismiss.active",
									{ activeId },
								),
							);
						}
						if (selfId && !isDescendantOf(targetId, selfId)) {
							const notDescId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`拒绝移出：子代理 ${notDescId} 不属于当前会话的派发族谱（仅允许移出由当前会话派发的子代理）。`,
									`Refused: subagent ${notDescId} does not belong to the descendant hierarchy of this conversation (can only dismiss subagents spawned by this conversation).`,
									"subagents.dismiss.not_descendant",
									{ notDescId },
								),
							);
						}
						if (snapshot.persisted && !p.includePersisted) {
							const persistedId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`子代理 ${persistedId} 为持久化会话（已落盘历史）。如确认需要移出，请传入 includePersisted=true。`,
									`Subagent ${persistedId} is a persistent session. If you are sure you want to dismiss it, pass includePersisted=true.`,
									"subagents.dismiss.persisted",
									{ persistedId },
								),
							);
						}
						const isRunning = snapshot.streaming || snapshot.state === "running";
						if (isRunning && !p.force) {
							const runningId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`子代理 ${runningId} 仍在运行中（状态：${snapshot.state}）。请等待其完成、调用 subagent(action="stop")，或指定 force=true 强行中止并移出。`,
									`Subagent ${runningId} is still running (state: ${snapshot.state}). Wait for it to finish, call subagent(action="stop"), or specify force=true to force abort and dismiss.`,
									"subagents.dismiss.running",
									{ runningId, state: snapshot.state },
								),
							);
						}
						if (host.finalizeSubagentWorktree) {
							await host.finalizeSubagentWorktree(targetId);
						}
						const updated = host.getSubagent(targetId) ?? snapshot;
						if (updated.worktree && !updated.worktree.cleanedUp) {
							const wt = updated.worktree;
							const isDirty = Boolean(wt.isDirty || (wt.uncommittedCount ?? 0) > 0 || (wt.aheadCount ?? 0) > 0);
							if (isDirty) {
								const dirtyId = shortId(targetId);
								return text(
									pick(
										getLang(),
										`子代理 ${dirtyId} 的工作树存在未合并改动，无法移出（静默移出会丢失代码）：\n- 路径：${wt.path}\n- 分支：${wt.branch}\n- 未提交改动：${wt.uncommittedCount ?? 0} 个文件，领先提交：${wt.aheadCount ?? 0} 个\n请先合并分支（git merge ${wt.branch}）或确认放弃后通过 worktree(action="remove", path="${wt.path}", force=true) 清理。`,
										`Subagent ${dirtyId} has unmerged worktree changes and cannot be dismissed (silent dismissal would lose code):\n- Path: ${wt.path}\n- Branch: ${wt.branch}\n- Changes: ${wt.uncommittedCount ?? 0} uncommitted file(s), ${wt.aheadCount ?? 0} commit(s) ahead\nPlease merge the branch (git merge ${wt.branch}) or discard changes via worktree(action="remove", path="${wt.path}", force=true).`,
										"subagents.dismiss.worktree.dirty",
										{
											dirtyId,
											path: wt.path,
											branch: wt.branch,
											uncommitted: wt.uncommittedCount ?? 0,
											ahead: wt.aheadCount ?? 0,
										},
									),
								);
							}
						}

						const res = await host.dismissSubagent(targetId, {
							force: p.force,
							includePersisted: p.includePersisted,
						});
						if (!res.ok) {
							const failedId = shortId(targetId);
							return text(
								pick(
									getLang(),
									`移出子代理 ${failedId} 失败：${res.reason ?? "未知原因"}。`,
									`Failed to dismiss subagent ${failedId}: ${res.reason ?? "unknown reason"}.`,
									"subagents.dismiss.failed",
									{ failedId, reason: res.reason ?? "unknown" },
								),
							);
						}
						const doneId = shortId(targetId);
						return text(
							pick(
								getLang(),
								`已移出子代理 ${doneId}。移出后不可逆（会话已从左栏移除并释放运行时与临时数据）。提示：如需获取产物，请在移出前调用 subagent(action="get_result")。`,
								`Dismissed subagent ${doneId}. Dismissal is irreversible (session removed from panel, runtime and temporary data released). Note: call subagent(action="get_result") before dismissal if you need its output.`,
								"subagents.dismiss.success.single",
								{ doneId },
							),
							{ dismissed: [targetId], skipped: [] },
						);
					}

					candidateIds.sort((a, b) => depthOf(b) - depthOf(a));

					const dismissed: string[] = [];
					const skipped: { runId: string; reason: string }[] = [];

					for (const targetId of candidateIds) {
						const snapshot = host.getSubagent(targetId);
						if (!snapshot) {
							skipped.push({ runId: targetId, reason: "not_found" });
							continue;
						}
						if (selfId && targetId === selfId) {
							skipped.push({ runId: targetId, reason: "self" });
							continue;
						}
						if (activeConvId && targetId === activeConvId) {
							skipped.push({ runId: targetId, reason: "active" });
							continue;
						}
						if (selfId && !isDescendantOf(targetId, selfId)) {
							skipped.push({ runId: targetId, reason: "not_descendant" });
							continue;
						}
						if (snapshot.persisted && !p.includePersisted) {
							skipped.push({ runId: targetId, reason: "persisted" });
							continue;
						}
						const isRunning = snapshot.streaming || snapshot.state === "running";
						if (isRunning && !p.force) {
							skipped.push({ runId: targetId, reason: "running" });
							continue;
						}
						if (host.finalizeSubagentWorktree) {
							await host.finalizeSubagentWorktree(targetId);
						}
						const updated = host.getSubagent(targetId) ?? snapshot;
						if (updated.worktree && !updated.worktree.cleanedUp) {
							const wt = updated.worktree;
							const isDirty = Boolean(wt.isDirty || (wt.uncommittedCount ?? 0) > 0 || (wt.aheadCount ?? 0) > 0);
							if (isDirty) {
								skipped.push({ runId: targetId, reason: "dirty_worktree" });
								continue;
							}
						}

						const res = await host.dismissSubagent(targetId, {
							force: p.force,
							includePersisted: p.includePersisted,
						});
						if (res.ok) {
							dismissed.push(targetId);
						} else {
							skipped.push({ runId: targetId, reason: res.reason ?? "failed" });
						}
					}

					if (dismissed.length === 0) {
						if (isFinishedAll) {
							return text(
								pick(
									getLang(),
									"没有可移出的已结束子代理。",
									"No finished subagents to dismiss.",
									"subagents.dismiss.finished_all.empty",
								),
								{ dismissed: [], skipped },
							);
						}
						return text(
							pick(getLang(), "没有成功移出任何子代理。", "No subagents were dismissed.", "subagents.dismiss.none"),
							{ dismissed: [], skipped },
						);
					}

					const skippedCount = skipped.length;
					const skippedZh = skippedCount > 0 ? `（${skippedCount} 个已跳过）` : "";
					const skippedEn = skippedCount > 0 ? ` (${skippedCount} skipped)` : "";
					return text(
						pick(
							getLang(),
							`已成功移出 ${dismissed.length} 个子代理${skippedZh}。移出后不可逆（会话已从左栏移除并释放运行时与临时数据）。提示：如需获取产物，请在移出前调用 subagent(action="get_result")。`,
							`Successfully dismissed ${dismissed.length} subagent(s)${skippedEn}. Dismissal is irreversible (sessions removed from panel, runtimes and temporary data released). Note: call subagent(action="get_result") before dismissal if you need their outputs.`,
							"subagents.dismiss.success.batch",
							{ count: dismissed.length, skippedZh, skippedEn },
						),
						{ dismissed, skipped },
					);
				}

				default:
					return text(
						pick(
							getLang(),
							`未知 action：${action}。支持的 action：spawn, get_result, steer, list, stop, wait_all, templates, handoff, dismiss。`,
							`Unknown action: ${action}. Supported actions: spawn, get_result, steer, list, stop, wait_all, templates, handoff, dismiss.`,
							"subagents.action.unknown",
							{ action },
						),
					);
			}
		},
	});
}

/**
 * 保持数组签名的子代理工具导出，兼容原有调用点与批处理包装。
 */
export function makeSubagentTools(
	host: SubagentToolHost,
	lang?: () => ServerLang,
	selfConvId?: string | (() => string | undefined),
): ToolDefinition[] {
	return [makeSubagentTool(host, lang, selfConvId)];
}

/** 短 id 前缀（前端展示/日志用）。 */
function shortId(id: string): string {
	return id.slice(0, 8);
}

/**
 * wait_all 收口时的长输出截断：留头（任务复述）+ 留尾（最终结论），中间折叠。
 * 旧实现只取前 30 行，长输出的子代理结论（一般在尾部）会被丢掉，模型收回一个
 * 没结论的摘要。短输出原样返回。
 */
function clipSubagentOutput(output: string, lang: ServerLang): string {
	const HEAD = 10;
	const TAIL = 30;
	const lines = output.split("\n");
	if (lines.length <= HEAD + TAIL + 5) return output;
	const omitted = lines.length - HEAD - TAIL;
	const marker =
		lang === "zh" ? `… [中间省略 ${omitted} 行，头尾保留] …` : `… [${omitted} lines omitted, head and tail kept] …`;
	return [...lines.slice(0, HEAD), marker, ...lines.slice(-TAIL)].join("\n");
}

/**
 * 收集 root 的传递子代理后代 id（parentId 链向上能走到 root 的；含嵌套的嵌套）。
 * root 自身不含；非子代理对话不含（普通对话不参与子代理清理口径）。
 * parentId 环（理论上不应出现）按 visited 截断，不会死循环。
 * 纯函数：后端 dismiss 流程与单测共用（前端左栏按同样口径镜像实现，见
 * LeftPanel finishedSubagentCount）。
 */
export function collectSubagentDescendantIds(
	items: ReadonlyArray<{ id: string; parentId?: string; isSubagent: boolean }>,
	rootId: string,
): string[] {
	const byId = new Map(items.map((c) => [c.id, c]));
	const out: string[] = [];
	for (const c of items) {
		if (!c.isSubagent || c.id === rootId) continue;
		let cur: { id: string; parentId?: string; isSubagent: boolean } | undefined = c;
		const seen = new Set<string>();
		while (cur?.parentId) {
			if (cur.parentId === rootId) {
				out.push(c.id);
				break;
			}
			if (seen.has(cur.parentId)) break;
			seen.add(cur.parentId);
			cur = byId.get(cur.parentId);
			if (!cur) break;
		}
	}
	return out;
}

/** 人类可读的终态判定：报错 > 中止 > done > running。 */
function subagentVerdict(r: SubagentSnapshot, lang: ServerLang = "en"): string {
	if (r.error) return pick(lang, "error（报错）", "error", "subagents.verdict.error");
	if (r.canceled) return pick(lang, "canceled（已中止）", "canceled", "subagents.verdict.canceled");
	return r.state;
}

/** 终态的可读说明（错误文本 / 中止说明 / 空）。运行中返回空。 */
function verdictText(r: SubagentSnapshot, lang: ServerLang = "en"): string {
	if (r.error)
		return pick(lang, `错误：${r.error}`, `Error: ${r.error}`, "subagents.verdict.error.detail", {
			"r.error": r.error,
		});
	if (r.canceled)
		return pick(lang, "（被中止，未产出结论）", "(Aborted, no conclusion produced.)", "subagents.verdict.aborted");
	return "";
}

/** 未完成部分的引导文案。 */
function promptRemaining(remaining: string[], lang: ServerLang = "en"): string {
	if (remaining.length === 0) return "";
	const pendingIds = remaining.map(shortId).join(", ");
	return pick(
		lang,
		`\n未完成：${pendingIds}。可再次调用 subagent（action="wait_all"）继续等待耗时任务，或使用 steer 补充指令 / stop 中止。`,
		`\nPending: ${pendingIds}. You may call subagent (action="wait_all") again to continue waiting for long tasks, or use steer to add instructions / stop to abort.`,
		"subagents.wait.pending",
		{ pendingIds: pendingIds },
	);
}
