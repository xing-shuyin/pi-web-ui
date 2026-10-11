/**
 * 工具守卫与模式拦截门控（Tool Guards & Mode Gates）
 *
 * 包含：
 * - 计划模式硬闸门（withPlanModeGate）
 * - 目标审查回合闸门（withGoalReviewGate）
 * - 审查者委派模式闸门（withDelegationGate）
 * - 插件守卫与人机协同审批（withToolGuard / makeLateToolGuard）
 * - 只读 / 工作区沙箱权限包装器（wrapWriteToolWithPermission / wrapEditToolWithPermission 等）
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { resolve } from "node:path";
import {
	createWriteToolDefinition,
	createEditToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "./i18n.js";
import { planModeDenial } from "./plan-mode.js";
import { goalReviewDenial } from "./goal-review-gate.js";
import { delegationDenial } from "./delegate-mode.js";
import { isPathInsideRoot, extractTargetPath, type ApprovalRule } from "./approval-rules.js";
import { checkDangerousToolCall, pluginApprovalCategory, type ToolApprovalResolution } from "./tool-approval.js";
import {
	denialText,
	type GuardedToolName,
	type ToolPreRequest,
	type ToolPostRequest,
	type ToolPostEdit,
} from "./plugin-tool-guard.js";
import type { UiApprovalCategory, UiApprovalHit } from "./protocol.js";
import type { AnyToolDefinition } from "./tool-overrides.js";
import {
	createRemoteSdkOperations,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	resolveRemoteWorkspacePath,
	restoreWorkspaceUriFromSessionDir,
} from "./remote-ssh-service.js";

/**
 * 插件工具拦截钩子（P1-5）：index.ts 注入，把 bash/read 的 pre/post 决策委托给
 * PluginManager（evaluateToolPre/evaluateToolPost）。未注入时零开销直通。
 */
export interface ToolGuardHook {
	pre: (
		req: ToolPreRequest,
		lang: string,
	) => Promise<{
		verdict:
			| { decision: "allow" }
			| { decision: "deny"; reason?: string; reasonEn?: string }
			| { decision: "ask"; reason?: string; reasonEn?: string };
		pluginId?: string;
	}>;
	post: (
		req: ToolPostRequest,
		lang: string,
	) => Promise<{ content?: Array<{ type: string; text?: string }>; pluginIds: string[] } | undefined>;
}

/** 人机协同审批回调（第 7 参数 = 命中的规则档位，供「允许同类」记忆；第 8 参数 = 命中清单，用于高危片段定位）。 */
export type AskApprovalFn = (
	toolCallId: string,
	toolName: string,
	params: unknown,
	reason?: string,
	reasonEn?: string,
	conversationId?: string,
	category?: UiApprovalCategory,
	hits?: UiApprovalHit[],
) => Promise<ToolApprovalResolution>;

/**
 * 计划模式闸门装饰（通用）：套在任何工具定义外层，只在**执行前**判定一次。
 * 与权限沙箱/插件守卫平行且更靠外 —— 计划模式是会话级硬约束，不给任何
 * 「记住同类/全部允许」的口子（允许了就等于放开了实施）。
 * 关闭时零开销（返回原定义，不包 execute）。
 */
export function withPlanModeGate(
	def: ToolDefinition,
	planMode: () => boolean,
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...def,
		execute: (async (...args: unknown[]) => {
			if (planMode()) {
				const params = args[1];
				const denied = planModeDenial(def.name, params);
				if (denied) {
					const reason = pick(getLang(), denied.reason, denied.reasonEn);
					const err = new Error(reason);
					(err as unknown as Record<string, unknown>).details = {
						guardDenied: true,
						planModeDenied: true,
						kind: denied.kind,
					};
					throw err;
				}
			}
			return (def.execute as (...a: unknown[]) => unknown)(...args);
		}) as ToolDefinition["execute"],
	};
}

/**
 * 目标审查回合闸门（server/goal-review-gate.ts）：主对话在 `awaitingVerdict`
 * 置位期间是审查者 —— 写类工具、非常规 bash、派发类工具、向用户提问一律拒。
 * 形状与 withPlanModeGate / withDelegationGate 同构，串在最外层（理由最贴合
 * 此刻：跟模型说「这是审查回合」比「这是计划/审查者模式」更有用）。闸门无状态
 * （每次执行只读 `awaitingVerdict`），verdict 落定即自动恢复，不存在钉死。
 */
export function withGoalReviewGate(
	def: ToolDefinition,
	reviewTurn: () => boolean,
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...def,
		execute: (async (...args: unknown[]) => {
			if (reviewTurn()) {
				const params = args[1];
				const denied = goalReviewDenial(def.name, params);
				if (denied) {
					return {
						content: [{ type: "text", text: pick(getLang(), denied.reason, denied.reasonEn) }],
						details: { guardDenied: true, goalReviewDenied: true, kind: denied.kind },
						isError: true,
					} as never;
				}
			}
			return (def.execute as (...a: unknown[]) => unknown)(...args);
		}) as ToolDefinition["execute"],
	};
}

/**
 * 审查者模式闸门（server/delegate-mode.ts）：主对话只审阅不施工 ——
 * 写类工具、非常规 bash、派发类工具一律拒。形状与 withPlanModeGate 同构，
 * 串在它**外层**（两者都开时，先问计划模式还是审查者模式都不影响结果：
 * 都是拒，只是理由不同）。
 */
export function withDelegationGate(
	def: ToolDefinition,
	delegateMode: () => boolean,
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...def,
		execute: (async (...args: unknown[]) => {
			if (delegateMode()) {
				const params = args[1];
				const denied = delegationDenial(def.name, params);
				if (denied) {
					return {
						content: [{ type: "text", text: pick(getLang(), denied.reason, denied.reasonEn) }],
						details: { guardDenied: true, delegateDenied: true, kind: denied.kind },
						isError: true,
					} as never;
				}
			}
			return (def.execute as (...a: unknown[]) => unknown)(...args);
		}) as ToolDefinition["execute"],
	};
}

/**
 * 把「可能晚一点才注入」的插件守卫包成**调用时解析**的代理。
 *
 * 为什么需要它（P1-5 的真实缺口）：`withToolGuard` 在建工具定义时就把 `opts.guard`
 * 捕进了闭包，而 runtime 是在 `ClientSession.create()` 里建的、`cs.toolGuard` 却是在
 * `AgentService.attach()` 末尾才赋值 —— 直接传 `this.toolGuard` 会把 `undefined`
 * 永久固化进那条对话的工具里，于是「attach 时恢复出来的那条对话」永远不受
 * 插件 `onToolPre/onToolPost` 约束（只有新建/切换对话才带上）。代理每次调用才解析，
 * 与赋值时序无关；未注入时逐字等价于直通（allow / undefined）。
 */
export function makeLateToolGuard(get: () => ToolGuardHook | undefined): ToolGuardHook {
	return {
		pre: (req, lang) => get()?.pre(req, lang) ?? Promise.resolve({ verdict: { decision: "allow" as const } }),
		post: (req, lang) => get()?.post(req, lang) ?? Promise.resolve(undefined),
	};
}

export function withToolGuard(
	def: ToolDefinition,
	opts: {
		toolName: GuardedToolName;
		guard?: ToolGuardHook;
		conversationId?: () => string | undefined;
		getLang: () => ServerLang;
		cwd?: string;
		getRoots?: () => string[];
		askApproval?: AskApprovalFn;
		getRules?: () => ApprovalRule[];
	},
): ToolDefinition {
	const guard = opts.guard;
	const toolName = opts.toolName;
	if (!guard && !opts.askApproval) return def;

	return {
		...def,
		execute: (async (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => {
			const lang = opts.getLang();
			const conversationId = opts.conversationId?.();
			let pre: Awaited<ReturnType<ToolGuardHook["pre"]>> | undefined;
			if (guard) {
				try {
					pre = await guard.pre({ toolName, params, conversationId }, lang);
				} catch {
					pre = { verdict: { decision: "allow" } };
				}
			}

			// 检查是否需要人工协同审批（Human-in-the-Loop）
			let needApproval = false;
			let approvalReason: string | undefined;
			let approvalReasonEn: string | undefined;
			let approvalCategory: UiApprovalCategory | undefined;

			// 1. 系统核心安全：内置高危操作检测与自定义审批规则先行（优先级最高，防短路）
			let danger: ReturnType<typeof checkDangerousToolCall> | undefined;
			if (opts.cwd && opts.askApproval) {
				danger = checkDangerousToolCall(toolName, params, opts.cwd, opts.getRoots?.() ?? [], opts.getRules?.());
				if (danger.denied) {
					const reasonText = danger.reason ? ` 原因：${danger.reason}` : "";
					const reasonTextEn = danger.reasonEn ? ` Reason: ${danger.reasonEn}` : "";
					const text = pick(
						lang,
						`【工具执行被审批规则直接阻断】${reasonText}`,
						`[Tool execution blocked by approval rule]${reasonTextEn}`,
					);
					return {
						content: [{ type: "text", text }],
						details: { guardDenied: true, ruleDenied: true, reason: danger.reason },
						isError: true,
					} as never;
				}
			}

			// 2. 插件前置守卫 deny 拦截（带 isError 标记）
			if (pre?.verdict.decision === "deny") {
				const text = denialText(pre.verdict, pre.pluginId ?? "plugin", lang);
				return {
					content: [{ type: "text", text }],
					details: { guardDenied: true, decision: pre.verdict.decision, pluginId: pre.pluginId },
					isError: true,
				} as never;
			}

			// 3. 决定是否需要弹窗审批（系统高危 ask 优先于插件通用 ask，防止恶意或低危插件掩盖高危告警）
			let approvalHits: UiApprovalHit[] | undefined;
			if (danger?.dangerous) {
				needApproval = true;
				approvalReason = danger.reason;
				approvalReasonEn = danger.reasonEn;
				approvalCategory = danger.category;
				approvalHits = danger.hits;
			} else if (pre?.verdict.decision === "ask") {
				needApproval = true;
				approvalReason = pre.verdict.reason ?? "插件要求确认本次操作";
				approvalReasonEn = pre.verdict.reasonEn ?? "Plugin requested confirmation for this operation";
				// 插件档位按插件 id 分：用户可以「允许同类」= 该插件的确认以后不再问。
				approvalCategory = pluginApprovalCategory(pre.pluginId ?? "plugin");
			}

			let effectiveParams = params;
			let userEdited = false;
			if (needApproval && opts.askApproval) {
				const res = await opts.askApproval(
					toolCallId,
					toolName,
					params,
					approvalReason,
					approvalReasonEn,
					conversationId,
					approvalCategory,
					approvalHits,
				);
				if (res.decision === "deny") {
					const reasonText = res.reason ? ` 原因：${res.reason}` : "";
					const reasonTextEn = res.reason ? ` Reason: ${res.reason}` : "";
					return {
						content: [
							{
								type: "text",
								text: pick(lang, `【操作被用户拒绝】${reasonText}`, `[Operation denied by user]${reasonTextEn}`),
							},
						],
						details: { guardDenied: true, userDenied: true, reason: res.reason },
						isError: true,
					} as never;
				} else if (res.decision === "edit") {
					effectiveParams = res.editedParams ?? params;
					userEdited = true;
				}
			} else if (pre?.verdict.decision === "ask") {
				// 无审批通道时回落至原先的阻断行为
				const text = denialText(pre.verdict, pre.pluginId ?? "plugin", lang);
				return {
					content: [{ type: "text", text }],
					details: { guardDenied: true, decision: pre.verdict.decision, pluginId: pre.pluginId },
					isError: true,
				} as never;
			}

			const result = (await (def.execute as (...a: never[]) => Promise<unknown>)(
				toolCallId as never,
				effectiveParams as never,
				signal as never,
				onUpdate as never,
				ctx as never,
			)) as {
				content?: Array<{ type: string; text?: string }>;
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};

			if (userEdited && result && typeof result === "object") {
				result.details = {
					...result.details,
					userEdited: true,
					originalParams: params,
					executedParams: effectiveParams,
				};
			}

			if (guard) {
				let post: ToolPostEdit | undefined | { content?: Array<{ type: string; text?: string }>; pluginIds: string[] };
				try {
					post = await guard.post({ toolName, params: effectiveParams, result, conversationId }, lang);
				} catch {
					post = undefined;
				}
				if (post?.content) return { ...result, content: post.content } as never;
			}
			return result as never;
		}) as never,
	} as ToolDefinition;
}

/** 校验目标路径是否在工作区（或多根工作区）内。严格规范化防止 ".." 逃逸与 Windows 盘符大小写不一致。 */
export function isInsideWorkspaceRoots(targetPath: string, cwd: string, roots: string[] = []): boolean {
	const effCwd = restoreWorkspaceUriFromSessionDir(cwd);
	if (isRemoteWorkspaceUri(effCwd)) {
		const parsed = parseRemoteWorkspaceUri(effCwd);
		if (!parsed) return false;
		return resolveRemoteWorkspacePath(parsed.remotePath, targetPath) !== null;
	}
	const abs = resolve(cwd, targetPath);
	const allRoots = [resolve(cwd), ...roots.map((r) => resolve(r))];
	return allRoots.some((r) => isPathInsideRoot(abs, r));
}

/**
 * 为 write 工具包装会话级权限沙箱与人机协同审批。
 * `base` = 覆盖基底：第三方扩展注册的同名 write 优先（见 tool-overrides.ts），
 * 省略则是 SDK 内置实现 —— 于是权限门禁叠在扩展实现之上，而不是把它顶掉。
 */
export function wrapWriteToolWithPermission(
	cwd: string,
	getPermission: () => string,
	getRoots: () => string[],
	getLang: () => ServerLang,
	askApproval?: AskApprovalFn,
	getConversationId?: () => string | undefined,
	getRules?: () => ApprovalRule[],
	base?: AnyToolDefinition,
): ToolDefinition {
	const remoteOps = !base ? createRemoteSdkOperations(cwd) : null;
	const effectiveBase: AnyToolDefinition =
		base ?? createWriteToolDefinition(cwd, remoteOps ? { operations: remoteOps.write } : undefined);
	return {
		...effectiveBase,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const perm = getPermission();
			if (perm === "read-only") {
				return {
					content: [
						{
							type: "text",
							text: pick(
								getLang(),
								"【权限被拒绝】当前会话处于「只读模式」（read-only），禁止写入文件。若需修改请切换权限预设。",
								"[Permission Denied] The current session is in 'read-only' mode; writing files is forbidden. Switch permission preset if needed.",
							),
						},
					],
					isError: true,
				} as never;
			}
			if (perm === "workspace-write-never") {
				const p = extractTargetPath(params);
				if (!isInsideWorkspaceRoots(p, cwd, getRoots())) {
					return {
						content: [
							{
								type: "text",
								text: pick(
									getLang(),
									`【权限被拒绝】当前会话处于「工作区内修改」（workspace-write-never）模式，禁止修改工作区外部文件（"${p}"）。若需修改请切换至「完全权限」。`,
									`[Permission Denied] The current session is in 'workspace-write-never' mode; writing files outside the workspace ("${p}") is forbidden. Switch to 'danger-full-access' if needed.`,
								),
							},
						],
						isError: true,
					} as never;
				}
			}

			// 高危写操作人机协同审批拦截（如敏感配置修改）与规则匹配
			let effectiveParams = params;
			let userEdited = false;
			if (askApproval) {
				const danger = checkDangerousToolCall("write", params, cwd, getRoots(), getRules?.());
				if (danger.denied) {
					return {
						content: [
							{
								type: "text",
								text: pick(
									getLang(),
									`【文件写入被审批规则直接阻断】${danger.reason ? ` 原因：${danger.reason}` : ""}`,
									`[File write blocked by approval rule]${danger.reason ? ` Reason: ${danger.reason}` : ""}`,
								),
							},
						],
						details: { guardDenied: true, ruleDenied: true, reason: danger.reason },
						isError: true,
					} as never;
				}
				if (danger.dangerous) {
					const res = await askApproval(
						toolCallId,
						"write",
						params,
						danger.reason,
						danger.reasonEn,
						getConversationId?.(),
						danger.category,
						danger.hits,
					);
					if (res.decision === "deny") {
						return {
							content: [
								{
									type: "text",
									text: pick(
										getLang(),
										`【文件写入被用户拒绝】${res.reason ? ` 原因：${res.reason}` : ""}`,
										`[File write denied by user]${res.reason ? ` Reason: ${res.reason}` : ""}`,
									),
								},
							],
							details: { guardDenied: true, userDenied: true, reason: res.reason },
							isError: true,
						} as never;
					} else if (res.decision === "edit") {
						effectiveParams = res.editedParams ?? params;
						userEdited = true;
					}
				}
			}

			const result = (await effectiveBase.execute(
				toolCallId,
				effectiveParams as never,
				signal,
				onUpdate,
				ctx,
			)) as unknown as {
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};
			if (userEdited && result && typeof result === "object") {
				result.details = {
					...result.details,
					userEdited: true,
					originalParams: params,
					executedParams: effectiveParams,
				};
			}
			return result as never;
		},
	} as ToolDefinition;
}

/**
 * `edit` 的模型可见主描述（仅无扩展覆盖时的基底用；有扩展 edit 时保留它自己的文案）。
 *
 * SDK 自带的描述与其自带 guidelines 几乎逐条复述（oldText 要唯一匹配 / 多处改动合成一次调用 /
 * 不要垫大段未改区域都说两遍），单条信息重复进上下文。这里只留一句「做什么」，细节交给
 * guidelines（它们是 SDK 的，本模块不碰）。
 */
export const EDIT_DESCRIPTION =
	"Edit a single file by exact text replacement: every edits[].oldText must uniquely match the original file.";

/** `edit` 的精简 guidelines（同上：只用于无扩展覆盖的基底；与 SDK 四条规则一一对应，只去冗余措辞）。 */
export const EDIT_GUIDELINES = [
	"Use edit for precise changes; oldText must match exactly",
	"When changing several separate locations in one file, put them in ONE call's edits[] instead of multiple calls",
	"Each oldText matches the original file, not earlier edits in the same call — never overlapping or nested",
	"Keep oldText small but unique; never pad with large unchanged regions",
];

/**
 * 为 edit 工具包装会话级权限沙箱与人机协同审批（基底语义同 write）。
 */
export function wrapEditToolWithPermission(
	cwd: string,
	getPermission: () => string,
	getRoots: () => string[],
	getLang: () => ServerLang,
	askApproval?: AskApprovalFn,
	getConversationId?: () => string | undefined,
	getRules?: () => ApprovalRule[],
	base?: AnyToolDefinition,
): ToolDefinition {
	const remoteOps = !base ? createRemoteSdkOperations(cwd) : null;
	const effectiveBase: AnyToolDefinition =
		base ?? createEditToolDefinition(cwd, remoteOps ? { operations: remoteOps.edit } : undefined);
	return {
		...effectiveBase,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const perm = getPermission();
			if (perm === "read-only") {
				return {
					content: [
						{
							type: "text",
							text: pick(
								getLang(),
								"【权限被拒绝】当前会话处于「只读模式」（read-only），禁止编辑文件。若需修改请切换权限预设。",
								"[Permission Denied] The current session is in 'read-only' mode; editing files is forbidden. Switch permission preset if needed.",
							),
						},
					],
					isError: true,
				} as never;
			}
			if (perm === "workspace-write-never") {
				const p = extractTargetPath(params);
				if (!isInsideWorkspaceRoots(p, cwd, getRoots())) {
					return {
						content: [
							{
								type: "text",
								text: pick(
									getLang(),
									`【权限被拒绝】当前会话处于「工作区内修改」（workspace-write-never）模式，禁止修改工作区外部文件（"${p}"）。若需修改请切换至「完全权限」。`,
									`[Permission Denied] The current session is in 'workspace-write-never' mode; editing files outside the workspace ("${p}") is forbidden. Switch to 'danger-full-access' if needed.`,
								),
							},
						],
						isError: true,
					} as never;
				}
			}

			// 高危修改人机协同审批拦截与规则匹配
			let effectiveParams = params;
			let userEdited = false;
			if (askApproval) {
				const danger = checkDangerousToolCall("edit", params, cwd, getRoots(), getRules?.());
				if (danger.denied) {
					return {
						content: [
							{
								type: "text",
								text: pick(
									getLang(),
									`【文件编辑被审批规则直接阻断】${danger.reason ? ` 原因：${danger.reason}` : ""}`,
									`[File edit blocked by approval rule]${danger.reason ? ` Reason: ${danger.reason}` : ""}`,
								),
							},
						],
						details: { guardDenied: true, ruleDenied: true, reason: danger.reason },
						isError: true,
					} as never;
				}
				if (danger.dangerous) {
					const res = await askApproval(
						toolCallId,
						"edit",
						params,
						danger.reason,
						danger.reasonEn,
						getConversationId?.(),
						danger.category,
						danger.hits,
					);
					if (res.decision === "deny") {
						return {
							content: [
								{
									type: "text",
									text: pick(
										getLang(),
										`【文件编辑被用户拒绝】${res.reason ? ` 原因：${res.reason}` : ""}`,
										`[File edit denied by user]${res.reason ? ` Reason: ${res.reason}` : ""}`,
									),
								},
							],
							details: { guardDenied: true, userDenied: true, reason: res.reason },
							isError: true,
						} as never;
					} else if (res.decision === "edit") {
						effectiveParams = res.editedParams ?? params;
						userEdited = true;
					}
				}
			}

			const result = (await effectiveBase.execute(
				toolCallId,
				effectiveParams as never,
				signal,
				onUpdate,
				ctx,
			)) as unknown as {
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};
			if (userEdited && result && typeof result === "object") {
				result.details = {
					...result.details,
					userEdited: true,
					originalParams: params,
					executedParams: effectiveParams,
				};
			}
			return result as never;
		},
	} as ToolDefinition;
}

/** 为 edit_soft 工具包装会话级权限沙箱与人机协同审批。 */
export function wrapEditSoftToolWithPermission(
	tool: ToolDefinition,
	cwd: string,
	getPermission: () => string,
	getRoots: () => string[],
	getLang: () => ServerLang,
	askApproval?: AskApprovalFn,
	getConversationId?: () => string | undefined,
	getRules?: () => ApprovalRule[],
): ToolDefinition {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const perm = getPermission();
			if (perm === "read-only") {
				return {
					content: [
						{
							type: "text",
							text: pick(
								getLang(),
								"【权限被拒绝】当前会话处于「只读模式」（read-only），禁止编辑文件。若需修改请切换权限预设。",
								"[Permission Denied] The current session is in 'read-only' mode; editing files is forbidden. Switch permission preset if needed.",
							),
						},
					],
					isError: true,
				} as never;
			}
			if (perm === "workspace-write-never") {
				const p = (params as { path?: string })?.path ?? "";
				if (!isInsideWorkspaceRoots(p, cwd, getRoots())) {
					return {
						content: [
							{
								type: "text",
								text: pick(
									getLang(),
									`【权限被拒绝】当前会话处于「工作区内修改」（workspace-write-never）模式，禁止修改工作区外部文件（"${p}"）。若需修改请切换至「完全权限」。`,
									`[Permission Denied] The current session is in 'workspace-write-never' mode; editing files outside the workspace ("${p}") is forbidden. Switch to 'danger-full-access' if needed.`,
								),
							},
						],
						isError: true,
					} as never;
				}
			}

			// 高危修改人机协同审批拦截与规则匹配
			let effectiveParams = params;
			let userEdited = false;
			if (askApproval) {
				const danger = checkDangerousToolCall("edit_soft", params, cwd, getRoots(), getRules?.());
				if (danger.denied) {
					return {
						content: [
							{
								type: "text",
								text: pick(
									getLang(),
									`【文件编辑被审批规则直接阻断】${danger.reason ? ` 原因：${danger.reason}` : ""}`,
									`[File edit blocked by approval rule]${danger.reason ? ` Reason: ${danger.reason}` : ""}`,
								),
							},
						],
						details: { guardDenied: true, ruleDenied: true, reason: danger.reason },
						isError: true,
					} as never;
				}
				if (danger.dangerous) {
					const res = await askApproval(
						toolCallId,
						"edit_soft",
						params,
						danger.reason,
						danger.reasonEn,
						getConversationId?.(),
						danger.category,
						danger.hits,
					);
					if (res.decision === "deny") {
						return {
							content: [
								{
									type: "text",
									text: pick(
										getLang(),
										`【文件编辑被用户拒绝】${res.reason ? ` 原因：${res.reason}` : ""}`,
										`[File edit denied by user]${res.reason ? ` Reason: ${res.reason}` : ""}`,
									),
								},
							],
							details: { guardDenied: true, userDenied: true, reason: res.reason },
							isError: true,
						} as never;
					} else if (res.decision === "edit") {
						effectiveParams = res.editedParams ?? params;
						userEdited = true;
					}
				}
			}

			const result = (await tool.execute(toolCallId, effectiveParams as never, signal, onUpdate, ctx)) as unknown as {
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};
			if (userEdited && result && typeof result === "object") {
				result.details = {
					...result.details,
					userEdited: true,
					originalParams: params,
					executedParams: effectiveParams,
				};
			}
			return result as never;
		},
	};
}

/** 为 bash 工具包装只读拦截。 */
export function wrapBashToolWithPermission(
	tool: ToolDefinition,
	getPermission: () => string,
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const perm = getPermission();
			if (perm === "read-only") {
				return {
					content: [
						{
							type: "text",
							text: pick(
								getLang(),
								"【权限被拒绝】当前会话处于「只读模式」（read-only），禁止执行终端命令。若需执行请切换权限预设。",
								"[Permission Denied] The current session is in 'read-only' mode; running shell commands is forbidden. Switch permission preset if needed.",
							),
						},
					],
					isError: true,
				} as never;
			}
			return tool.execute(toolCallId, params as never, signal, onUpdate, ctx);
		},
	};
}
