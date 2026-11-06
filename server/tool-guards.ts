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
import { parseHashlinePatch } from "./hashline-engine.js";
import {
	denialText,
	type GuardedToolName,
	type ToolPreRequest,
	type ToolPostRequest,
	type ToolPostEdit,
} from "./plugin-tool-guard.js";
import type { UiApprovalCategory, UiApprovalHit } from "./protocol.js";
import type { AnyToolDefinition } from "./tool-overrides.js";
import type { ToolAuditRecordFn } from "./approval-audit.js";
import {
	createRemoteSdkOperations,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	resolveRemoteWorkspacePath,
	restoreWorkspaceUriFromSessionDir,
} from "./remote-ssh-service.js";

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

export type AskApprovalFn = (
	toolCallId: string,
	toolName: string,
	params: unknown,
	reason?: string,
	reasonEn?: string,
	conversationId?: string,
	category?: UiApprovalCategory,
	hits?: UiApprovalHit[],
	signal?: AbortSignal,
) => Promise<ToolApprovalResolution>;

function checkCancellation(signal: unknown): asserts signal is AbortSignal | undefined {
	(signal as AbortSignal | undefined)?.throwIfAborted();
}

export function withPlanModeGate(
	def: ToolDefinition,
	planMode: () => boolean,
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...def,
		execute: (async (...args: unknown[]) => {
			checkCancellation(args[2]);
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
			checkCancellation(args[2]);
			return (def.execute as (...a: unknown[]) => unknown)(...args);
		}) as ToolDefinition["execute"],
	};
}

export function withGoalReviewGate(
	def: ToolDefinition,
	reviewTurn: () => boolean,
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...def,
		execute: (async (...args: unknown[]) => {
			checkCancellation(args[2]);
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
			checkCancellation(args[2]);
			return (def.execute as (...a: unknown[]) => unknown)(...args);
		}) as ToolDefinition["execute"],
	};
}

export const APPROVAL_GUARDED = Symbol.for("pi.approvalGuarded");

export function withApprovalGate(
	def: ToolDefinition,
	opts: {
		cwd: () => string;
		getRoots?: () => string[];
		getRules?: () => ApprovalRule[];
		getLang: () => ServerLang;
		conversationId?: () => string | undefined;
		askApproval?: AskApprovalFn;
		onAudit?: ToolAuditRecordFn;
	},
): ToolDefinition {
	if ((def as unknown as Record<symbol, unknown>)[APPROVAL_GUARDED]) {
		return def;
	}

	const wrapped: ToolDefinition = {
		...def,
		execute: (async (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => {
			checkCancellation(signal);
			const lang = opts.getLang();
			const conversationId = opts.conversationId?.();
			const cwd = opts.cwd();
			const roots = opts.getRoots?.() ?? [];
			const rules = opts.getRules?.();

			const danger = checkDangerousToolCall(def.name, params, cwd, roots, rules);
			if (danger.denied) {
				opts.onAudit?.({
					conversationId,
					toolName: def.name,
					params,
					decision: "denied",
					decisionSource: "rule_denied",
					categoryId: danger.category?.id,
					reason: danger.reason,
				});
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

			let effectiveParams = params;
			if (danger.dangerous && opts.askApproval) {
				const res = await opts.askApproval(
					toolCallId,
					def.name,
					params,
					danger.reason,
					danger.reasonEn,
					conversationId,
					danger.category,
					danger.hits,
					signal,
				);
				checkCancellation(signal);
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
				}
			}

			checkCancellation(signal);
			return (def.execute as (...args: unknown[]) => unknown)(toolCallId, effectiveParams, signal, onUpdate, ctx);
		}) as ToolDefinition["execute"],
	};

	Object.assign(wrapped, { [APPROVAL_GUARDED]: true });
	return wrapped;
}

export function withDelegationGate(
	def: ToolDefinition,
	delegateMode: () => boolean,
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...def,
		execute: (async (...args: unknown[]) => {
			checkCancellation(args[2]);
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
			checkCancellation(args[2]);
			return (def.execute as (...a: unknown[]) => unknown)(...args);
		}) as ToolDefinition["execute"],
	};
}

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
		onAudit?: ToolAuditRecordFn;
	},
): ToolDefinition {
	const guard = opts.guard;
	const toolName = opts.toolName;
	if (!guard && !opts.askApproval) return def;

	return {
		...def,
		execute: (async (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => {
			checkCancellation(signal);
			const lang = opts.getLang();
			const conversationId = opts.conversationId?.();
			let pre: Awaited<ReturnType<ToolGuardHook["pre"]>> | undefined;
			if (guard) {
				try {
					pre = await guard.pre({ toolName, params, conversationId }, lang);
				} catch {
					pre = { verdict: { decision: "allow" } };
				}
				checkCancellation(signal);
			}

			let needApproval = false;
			let approvalReason: string | undefined;
			let approvalReasonEn: string | undefined;
			let approvalCategory: UiApprovalCategory | undefined;

			let danger: ReturnType<typeof checkDangerousToolCall> | undefined;
			if (opts.cwd && opts.askApproval) {
				danger = checkDangerousToolCall(toolName, params, opts.cwd, opts.getRoots?.() ?? [], opts.getRules?.());
				if (danger.denied) {
					opts.onAudit?.({
						conversationId,
						toolName,
						params,
						decision: "denied",
						decisionSource: "rule_denied",
						categoryId: danger.category?.id,
						reason: danger.reason,
					});
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

			if (pre?.verdict.decision === "deny") {
				const text = denialText(pre.verdict, pre.pluginId ?? "plugin", lang);
				return {
					content: [{ type: "text", text }],
					details: { guardDenied: true, decision: pre.verdict.decision, pluginId: pre.pluginId },
					isError: true,
				} as never;
			}

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
					signal,
				);
				checkCancellation(signal);
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
				const text = denialText(pre.verdict, pre.pluginId ?? "plugin", lang);
				return {
					content: [{ type: "text", text }],
					details: { guardDenied: true, decision: pre.verdict.decision, pluginId: pre.pluginId },
					isError: true,
				} as never;
			}

			checkCancellation(signal);
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
			checkCancellation(signal);

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
				checkCancellation(signal);
				if (post?.content) return { ...result, content: post.content } as never;
			}
			return result as never;
		}) as never,
		[APPROVAL_GUARDED]: true,
	} as ToolDefinition;
}

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
			checkCancellation(signal);
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
						signal,
					);
					checkCancellation(signal);
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

			checkCancellation(signal);
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
			checkCancellation(signal);
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
		[APPROVAL_GUARDED]: true,
	} as ToolDefinition;
}

export const EDIT_DESCRIPTION =
	"Edit a single file by exact text replacement: every edits[].oldText must uniquely match the original file.";

export const EDIT_GUIDELINES = [
	"Use edit for precise changes; oldText must match exactly",
	"When changing several separate locations in one file, put them in ONE call's edits[] instead of multiple calls",
	"Each oldText matches the original file, not earlier edits in the same call — never overlapping or nested",
	"Keep oldText small but unique; never pad with large unchanged regions",
];

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
			checkCancellation(signal);
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
						signal,
					);
					checkCancellation(signal);
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

			checkCancellation(signal);
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
			checkCancellation(signal);
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
		[APPROVAL_GUARDED]: true,
	} as ToolDefinition;
}

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
			checkCancellation(signal);
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
						signal,
					);
					checkCancellation(signal);
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

			checkCancellation(signal);
			const result = (await tool.execute(toolCallId, effectiveParams as never, signal, onUpdate, ctx)) as unknown as {
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};
			checkCancellation(signal);
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
		[APPROVAL_GUARDED]: true,
	} as ToolDefinition;
}

export function wrapPatchToolWithPermission(
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
			checkCancellation(signal);
			const patchText =
				typeof (params as { patch?: unknown })?.patch === "string" ? (params as { patch: string }).patch : "";
			let targets: string[] = [];
			try {
				const sections = parseHashlinePatch(patchText);
				for (const sec of sections) {
					targets.push(sec.filePath);
					for (const h of sec.hunks) {
						if (h.kind === "move_file" && h.targetPath) targets.push(h.targetPath);
					}
				}
				targets = [...new Set(targets.filter((t) => t.trim()))];
			} catch {
				targets = [];
			}

			const perm = getPermission();
			if (perm === "read-only") {
				return {
					content: [
						{
							type: "text",
							text: pick(
								getLang(),
								"【权限被拒绝】当前会话处于「只读模式」（read-only），禁止应用补丁修改文件。若需修改请切换权限预设。",
								"[Permission Denied] The current session is in 'read-only' mode; applying patches is forbidden. Switch permission preset if needed.",
							),
						},
					],
					isError: true,
				} as never;
			}
			if (perm === "workspace-write-never") {
				const outside = targets.filter((p) => !isInsideWorkspaceRoots(p, cwd, getRoots()));
				if (outside.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: pick(
									getLang(),
									`【权限被拒绝】当前会话处于「工作区内修改」（workspace-write-never）模式，禁止修改工作区外部文件（${outside.map((p) => `"${p}"`).join("、")}）。若需修改请切换至「完全权限」。`,
									`[Permission Denied] The current session is in 'workspace-write-never' mode; patching files outside the workspace (${outside.map((p) => `"${p}"`).join(", ")}) is forbidden. Switch to 'danger-full-access' if needed.`,
								),
							},
						],
						isError: true,
					} as never;
				}
			}

			let effectiveParams = params;
			let userEdited = false;
			if (askApproval) {
				let denied: ReturnType<typeof checkDangerousToolCall> | undefined;
				let asked: ReturnType<typeof checkDangerousToolCall> | undefined;
				let askedPath = "";
				for (const p of targets) {
					const synth = { ...(params as Record<string, unknown>), path: p };
					const danger = checkDangerousToolCall("patch", synth, cwd, getRoots(), getRules?.());
					if (danger.denied) {
						denied = danger;
						break;
					}
					if (danger.dangerous && !asked) {
						asked = danger;
						askedPath = p;
					}
				}
				if (denied) {
					return {
						content: [
							{
								type: "text",
								text: pick(
									getLang(),
									`【补丁被审批规则直接阻断】${denied.reason ? ` 原因：${denied.reason}` : ""}`,
									`[Patch blocked by approval rule]${denied.reason ? ` Reason: ${denied.reason}` : ""}`,
								),
							},
						],
						details: { guardDenied: true, ruleDenied: true, reason: denied.reason },
						isError: true,
					} as never;
				}
				if (asked) {
					const res = await askApproval(
						toolCallId,
						"patch",
						{ ...(params as Record<string, unknown>), path: askedPath },
						asked.reason,
						asked.reasonEn,
						getConversationId?.(),
						asked.category,
						asked.hits,
						signal,
					);
					checkCancellation(signal);
					if (res.decision === "deny") {
						return {
							content: [
								{
									type: "text",
									text: pick(
										getLang(),
										`【补丁被用户拒绝】${res.reason ? ` 原因：${res.reason}` : ""}`,
										`[Patch denied by user]${res.reason ? ` Reason: ${res.reason}` : ""}`,
									),
								},
							],
							details: { guardDenied: true, userDenied: true, reason: res.reason },
							isError: true,
						} as never;
					} else if (res.decision === "edit") {
						const editedPatch = (res.editedParams as { patch?: unknown } | undefined)?.patch;
						if (typeof editedPatch === "string" && editedPatch !== patchText) {
							effectiveParams = { ...(params as Record<string, unknown>), patch: editedPatch };
							userEdited = true;
						}
					}
				}
			}

			checkCancellation(signal);
			const result = (await tool.execute(toolCallId, effectiveParams as never, signal, onUpdate, ctx)) as unknown as {
				details?: Record<string, unknown>;
				[k: string]: unknown;
			};
			checkCancellation(signal);
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
		[APPROVAL_GUARDED]: true,
	} as ToolDefinition;
}

export function wrapBashToolWithPermission(
	tool: ToolDefinition,
	getPermission: () => string,
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			checkCancellation(signal);
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
			checkCancellation(signal);
			return tool.execute(toolCallId, params as never, signal, onUpdate, ctx);
		},
	};
}
