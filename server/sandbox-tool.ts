import { Type, type Static } from "typebox";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "./i18n.js";
import type { SandboxInfo } from "./protocol.js";
import type { SandboxManager } from "./sandbox-service.js";
import type { AskApprovalFn } from "./tool-guards.js";

export const SANDBOX_TOOL_NAME = "sandbox";

const SandboxParameters = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("create"),
			Type.Literal("diff"),
			Type.Literal("reset"),
			Type.Literal("persist"),
			Type.Literal("promote"),
			Type.Literal("apply_to_source"),
			Type.Literal("destroy"),
		],
		{
			description:
				"Operation to perform: list | create | diff | reset | persist | promote | apply_to_source | destroy.",
		},
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("blank"), Type.Literal("import")], {
			description:
				'create: "import" clones an existing project into an isolated sandbox (default); "blank" creates an empty sandbox.',
		}),
	),
	sourcePath: Type.Optional(
		Type.String({
			description:
				'create (when mode="import"): source directory path to clone. Defaults to the current workspace (or its original sourcePath if already in a sandbox).',
		}),
	),
	name: Type.Optional(
		Type.String({
			description: "create: optional display name for the sandbox.",
		}),
	),
	ephemeral: Type.Optional(
		Type.Boolean({
			description: "create: true (default) for a temporary sandbox; false for a permanent sandbox.",
		}),
	),
	switchTo: Type.Optional(
		Type.Boolean({
			description:
				"create/promote: true to switch the active workspace to the created/exported directory immediately; false (default for create) keeps the current workspace and returns the sandbox path (useful for spawning a subagent with cwd).",
		}),
	),
	sandbox: Type.Optional(
		Type.String({
			description:
				"diff/reset/persist/promote/apply_to_source/destroy: target sandbox ID or path. Defaults to the current workspace if it is a sandbox.",
		}),
	),
	targetPath: Type.Optional(
		Type.String({
			description: "promote: destination directory path outside sandboxes (must be a new or empty directory).",
		}),
	),
});

export type SandboxToolInput = Static<typeof SandboxParameters>;

export interface SandboxToolHost {
	sandboxes: SandboxManager;
	getCwd: () => string;
	setCwd: (newCwd: string) => Promise<void>;
	onSandboxesChanged: () => Promise<void>;
	askApproval?: AskApprovalFn;
	getConversationId?: () => string | undefined;
	resetSandbox: (target: string) => ReturnType<SandboxManager["reset"]>;
	destroySandbox: (target: string) => ReturnType<SandboxManager["destroy"]>;
	applySandboxToSource: (target: string, expectedRevision: string) => ReturnType<SandboxManager["applyToSource"]>;
}

const MAX_DIFF_FILES_IN_DETAILS = 100;

export function makeSandboxTool(
	host: SandboxToolHost,
	getLang: () => ServerLang,
): ToolDefinition<typeof SandboxParameters> {
	return {
		name: SANDBOX_TOOL_NAME,
		label: "Manage isolated sandbox workspaces",
		description:
			"Create, inspect, diff, reset, export, or destroy isolated copy-on-write sandbox workspaces. " +
			"Supports blank sandboxes or imported project copies (auto-skipping node_modules and build caches) where edits never touch the original files.",
		promptSnippet: "create or manage isolated sandbox workspaces for safe experimentation",
		promptGuidelines: [
			"Use sandbox(action='create') for risky refactors, dependency upgrades, or standalone prototypes so original project files remain untouched",
			"Run sandbox(action='diff') to review changed files before calling sandbox(action='apply_to_source')",
		],
		parameters: SandboxParameters,
		async execute(toolCallId, params: SandboxToolInput): Promise<AgentToolResult<unknown>> {
			const lang = getLang();
			const cwd = host.getCwd();
			const activeSbx = host.sandboxes.getByCwd(cwd);

			try {
				if (activeSbx) {
					if (!["list", "persist"].includes(params.action)) {
						throw new Error("Sandbox control and source comparison must be requested from outside the sandbox");
					}
					const target = params.sandbox?.trim();
					if (target && target !== activeSbx.id && target !== activeSbx.path) {
						throw new Error("Sandbox tools cannot access another sandbox");
					}
				}
				switch (params.action) {
					case "list": {
						const list = activeSbx ? [activeSbx] : host.sandboxes.list();
						if (list.length === 0) {
							return {
								content: [
									{
										type: "text",
										text: pick(
											lang,
											"当前没有任何沙盒项目。可调用 sandbox(action='create') 创建空白或导入型隔离沙盒。",
											"No sandbox projects exist. Call sandbox(action='create') to create a blank or imported isolated sandbox.",
										),
									},
								],
								details: { action: "list", count: 0, activeSandboxId: null },
							};
						}
						const lines = list.map((s) => {
							const activeMark = activeSbx?.id === s.id ? " [ACTIVE]" : "";
							const life = s.ephemeral ? "ephemeral" : "permanent";
							const src = s.sourcePath ? ` (source: ${s.sourcePath})` : " (blank)";
							return `- ${s.id}${activeMark}: "${s.name}" [${life}] -> ${s.path}${src}`;
						});
						return {
							content: [
								{
									type: "text",
									text:
										pick(
											lang,
											`共 ${list.length} 个沙盒项目${activeSbx ? `（当前处于沙盒 ${activeSbx.id}）` : ""}：\n`,
											`Found ${list.length} sandbox project(s)${activeSbx ? ` (currently inside ${activeSbx.id})` : ""}:\n`,
										) + lines.join("\n"),
								},
							],
							details: {
								action: "list",
								count: list.length,
								activeSandboxId: activeSbx?.id ?? null,
								sandboxes: list.slice(0, 30),
							},
						};
					}

					case "create": {
						const mode = params.mode ?? "import";
						let sourcePath: string | undefined;
						if (mode === "import") {
							sourcePath = params.sourcePath?.trim() || activeSbx?.sourcePath || cwd;
						}
						const { sandbox, copiedFiles, skippedFiles } = await host.sandboxes.create({
							name: params.name,
							sourcePath,
							ephemeral: params.ephemeral ?? true,
						});
						const shouldSwitch = params.switchTo === true;
						if (shouldSwitch) {
							await host.setCwd(sandbox.path);
						}
						await host.onSandboxesChanged();

						const summaryZh =
							`🧪 已创建沙盒「${sandbox.name}」（ID: ${sandbox.id}）\n` +
							`- 沙盒路径: ${sandbox.path}\n` +
							`- 模式: ${sandbox.sourcePath ? `从源项目导入（${sandbox.sourcePath}，共复制 ${copiedFiles} 个文件）` : "空白沙盒"}\n` +
							`- 生命周期: ${sandbox.ephemeral ? "临时沙盒" : "永久沙盒"}\n` +
							`- 当前工作区: ${shouldSwitch ? `已切换到该沙盒 (${sandbox.path})` : `保持原工作区 (${cwd})；你可将 cwd="${sandbox.path}" 传给 subagent 或调用 set_cwd`}`;
						const summaryEn =
							`🧪 Created sandbox "${sandbox.name}" (ID: ${sandbox.id})\n` +
							`- Path: ${sandbox.path}\n` +
							`- Mode: ${sandbox.sourcePath ? `imported from "${sandbox.sourcePath}" (${copiedFiles} files copied)` : "blank sandbox"}\n` +
							`- Lifecycle: ${sandbox.ephemeral ? "ephemeral" : "permanent"}\n` +
							`- Active workspace: ${shouldSwitch ? `switched to sandbox (${sandbox.path})` : `unchanged (${cwd}); pass cwd="${sandbox.path}" to subagent or switch workspace`}`;

						return {
							content: [{ type: "text", text: pick(lang, summaryZh, summaryEn) }],
							details: {
								action: "create",
								sandbox,
								copiedFiles,
								skippedFiles,
								switched: shouldSwitch,
							},
						};
					}

					case "diff": {
						const target = params.sandbox?.trim() || activeSbx?.id || cwd;
						const diff = await host.sandboxes.diffWithSource(target);
						const totalChanges = diff.added.length + diff.modified.length + diff.deleted.length;
						const formatList = (label: string, items: string[]) => {
							if (items.length === 0) return "";
							const shown = items
								.slice(0, 50)
								.map((f) => `  ${label} ${f}`)
								.join("\n");
							const more = items.length > 50 ? `\n  ... (+${items.length - 50} more)` : "";
							return `${shown}${more}\n`;
						};

						const headerZh =
							`📊 沙盒「${diff.sandbox.name}」(${diff.sandbox.id}) 变更对比：\n` +
							(diff.sourcePath ? `- 源项目: ${diff.sourcePath}\n` : `- 类型: 空白沙盒\n`) +
							`- 统计: 新增 ${diff.added.length} · 修改 ${diff.modified.length} · 删除 ${diff.deleted.length} · 未变 ${diff.unchangedCount}\n`;
						const headerEn =
							`📊 Sandbox "${diff.sandbox.name}" (${diff.sandbox.id}) diff summary:\n` +
							(diff.sourcePath ? `- Source: ${diff.sourcePath}\n` : `- Type: blank sandbox\n`) +
							`- Stats: +${diff.added.length} added · ~${diff.modified.length} modified · -${diff.deleted.length} deleted · ${diff.unchangedCount} unchanged\n`;

						const body =
							totalChanges === 0
								? pick(lang, "（与源项目完全一致，无文件变更）", "(Identical to source project; no file changes)")
								: `${formatList("+", diff.added)}${formatList("~", diff.modified)}${formatList("-", diff.deleted)}`.trimEnd();

						return {
							content: [{ type: "text", text: `${pick(lang, headerZh, headerEn)}\n${body}` }],
							details: {
								action: "diff",
								sandboxId: diff.sandbox.id,
								sourcePath: diff.sourcePath,
								addedCount: diff.added.length,
								modifiedCount: diff.modified.length,
								deletedCount: diff.deleted.length,
								unchangedCount: diff.unchangedCount,
								added: diff.added.slice(0, MAX_DIFF_FILES_IN_DETAILS),
								modified: diff.modified.slice(0, MAX_DIFF_FILES_IN_DETAILS),
								deleted: diff.deleted.slice(0, MAX_DIFF_FILES_IN_DETAILS),
							},
						};
					}

					case "reset": {
						const target = params.sandbox?.trim() || activeSbx?.id || cwd;
						if (activeSbx) throw new Error("Reset must be requested from outside the sandbox");
						const { sandbox, copiedFiles } = await host.resetSandbox(target);
						await host.onSandboxesChanged();
						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										`🔄 已重置沙盒「${sandbox.name}」（${sandbox.sourcePath ? `已从源项目重新同步 ${copiedFiles} 个文件` : "已清空恢复初始状态"}）。`,
										`🔄 Reset sandbox "${sandbox.name}" (${sandbox.sourcePath ? `re-synced ${copiedFiles} files from source` : "cleared to initial blank state"}).`,
									),
								},
							],
							details: { action: "reset", sandbox, copiedFiles },
						};
					}

					case "persist": {
						const target = params.sandbox?.trim() || activeSbx?.id || cwd;
						const sandbox = host.sandboxes.persist(target);
						await host.onSandboxesChanged();
						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										`📌 沙盒「${sandbox.name}」（${sandbox.id}）已转为永久沙盒。`,
										`📌 Sandbox "${sandbox.name}" (${sandbox.id}) is now permanent.`,
									),
								},
							],
							details: { action: "persist", sandbox },
						};
					}

					case "promote": {
						const targetPath = params.targetPath?.trim();
						if (!targetPath) {
							return {
								content: [
									{
										type: "text",
										text: pick(
											lang,
											"promote 操作需要提供 targetPath（目标正式项目路径）。",
											"promote requires a targetPath (destination directory path).",
										),
									},
								],
								details: {},
								isError: true,
							};
						}
						const target = params.sandbox?.trim() || activeSbx?.id || cwd;
						const {
							sandbox,
							targetPath: resolvedTarget,
							copiedFiles,
						} = await host.sandboxes.promote(target, targetPath);
						if (params.switchTo) {
							await host.setCwd(resolvedTarget);
						}
						await host.onSandboxesChanged();
						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										`📤 已将沙盒「${sandbox.name}」导出为正式项目：${resolvedTarget}（共 ${copiedFiles} 个文件）。`,
										`📤 Exported sandbox "${sandbox.name}" to formal project: ${resolvedTarget} (${copiedFiles} files).`,
									),
								},
							],
							details: { action: "promote", sandbox, targetPath: resolvedTarget, copiedFiles },
						};
					}

					case "apply_to_source": {
						const target = params.sandbox?.trim() || activeSbx?.id || cwd;
						const diff = await host.sandboxes.diffWithSource(target);
						if (!diff.sourcePath) {
							return {
								content: [
									{
										type: "text",
										text: pick(
											lang,
											`沙盒「${diff.sandbox.name}」是空白沙盒，没有关联的源项目，请改用 promote 导出到新目录。`,
											`Sandbox "${diff.sandbox.name}" is a blank sandbox with no sourcePath; use promote to export it to a new directory instead.`,
										),
									},
								],
								details: {},
								isError: true,
							};
						}

						if (host.askApproval) {
							const diffSummaryZh = [
								diff.added.length > 0 ? `新增 ${diff.added.length}` : "",
								diff.modified.length > 0 ? `修改 ${diff.modified.length}` : "",
								diff.deleted.length > 0 ? `删除 ${diff.deleted.length}` : "",
							]
								.filter(Boolean)
								.join("、");
							const diffSummaryEn = [
								diff.added.length > 0 ? `+${diff.added.length} added` : "",
								diff.modified.length > 0 ? `~${diff.modified.length} modified` : "",
								diff.deleted.length > 0 ? `-${diff.deleted.length} deleted` : "",
							]
								.filter(Boolean)
								.join(", ");
							const reasonZh = `将沙盒「${diff.sandbox.name}」的改动（${diffSummaryZh || "无变更"}）写回源项目 ${diff.sourcePath}`;
							const reasonEn = `Sync changes from sandbox "${diff.sandbox.name}" (${diffSummaryEn || "no changes"}) back to source project ${diff.sourcePath}`;
							const decision = await host.askApproval(
								toolCallId,
								SANDBOX_TOOL_NAME,
								{
									action: "apply_to_source",
									sandbox: diff.sandbox.id,
									sourcePath: diff.sourcePath,
									added: diff.added.slice(0, 30),
									modified: diff.modified.slice(0, 30),
									deleted: diff.deleted.slice(0, 30),
								},
								reasonZh,
								reasonEn,
								host.getConversationId?.(),
								{
									id: "sandbox.apply-to-source",
									label: "沙盒修改写回源项目",
									labelEn: "Apply sandbox changes to source",
								},
							);
							if (decision.decision === "deny") {
								return {
									content: [
										{
											type: "text",
											text: pick(
												lang,
												`【写回源项目被用户拒绝】${decision.reason ? `原因：${decision.reason}` : ""}`,
												`[Sync to source project denied by user]${decision.reason ? ` Reason: ${decision.reason}` : ""}`,
											),
										},
									],
									details: { guardDenied: true, userDenied: true },
									isError: true,
								};
							}
						}

						if (activeSbx) throw new Error("Apply must be requested from outside the sandbox");
						const res = await host.applySandboxToSource(diff.sandbox.id, diff.expectedRevision!);
						await host.onSandboxesChanged();
						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										`✅ 已将沙盒「${res.sandbox.name}」的变更同步写回源项目：${res.sourcePath}（同步 ${res.copiedFiles} 个文件${res.deletedFiles ? `，清理 ${res.deletedFiles} 个已删除文件` : ""}）`,
										`✅ Synced changes from sandbox "${res.sandbox.name}" back to source project: ${res.sourcePath} (${res.copiedFiles} files synced${res.deletedFiles ? `, ${res.deletedFiles} deleted files pruned` : ""})`,
									),
								},
							],
							details: {
								action: "apply_to_source",
								sandbox: res.sandbox,
								sourcePath: res.sourcePath,
								copiedFiles: res.copiedFiles,
								deletedFiles: res.deletedFiles ?? 0,
							},
						};
					}

					case "destroy": {
						const target = params.sandbox?.trim();
						if (!target) {
							return {
								content: [
									{
										type: "text",
										text: pick(
											lang,
											"destroy 操作需要显式指定要销毁的沙盒 ID 或路径（参数 sandbox）。",
											"destroy requires an explicit target sandbox ID or path (parameter 'sandbox').",
										),
									},
								],
								details: {},
								isError: true,
							};
						}
						const targetInfo: SandboxInfo | undefined = host.sandboxes.get(target) ?? host.sandboxes.getByCwd(target);
						if (!targetInfo) {
							return {
								content: [
									{
										type: "text",
										text: pick(lang, `未找到指定的沙盒：${target}`, `Sandbox not found: ${target}`),
									},
								],
								details: {},
								isError: true,
							};
						}
						if (host.askApproval) {
							const decision = await host.askApproval(
								toolCallId,
								SANDBOX_TOOL_NAME,
								{
									action: "destroy",
									sandbox: targetInfo.id,
									path: targetInfo.path,
									sourcePath: targetInfo.sourcePath,
								},
								`将销毁沙盒「${targetInfo.name}」（${targetInfo.path}${targetInfo.ephemeral ? "" : "，永久沙盒"}）并删除其全部内容，不可撤销`,
								`Destroy sandbox "${targetInfo.name}" (${targetInfo.path}${targetInfo.ephemeral ? "" : ", persistent"}) and remove all of its contents. This cannot be undone.`,
								host.getConversationId?.(),
								{
									id: "sandbox.destroy",
									label: "销毁沙盒",
									labelEn: "Destroy sandbox",
								},
							);
							if (decision.decision === "deny") {
								return {
									content: [
										{
											type: "text",
											text: pick(
												lang,
												`【销毁沙盒被用户拒绝】${decision.reason ? `原因：${decision.reason}` : ""}`,
												`[Sandbox destroy denied by user]${decision.reason ? ` Reason: ${decision.reason}` : ""}`,
											),
										},
									],
									details: { guardDenied: true, userDenied: true },
									isError: true,
								};
							}
						}
						if (activeSbx?.id === targetInfo.id) {
							await host.setCwd(
								targetInfo.sourcePath && existsSync(targetInfo.sourcePath) ? targetInfo.sourcePath : homedir(),
							);
						}
						if (activeSbx) throw new Error("Destroy must be requested from outside the sandbox");
						const destroyed = await host.destroySandbox(targetInfo.id);
						if (!destroyed) throw new Error("Sandbox was not destroyed");
						await host.onSandboxesChanged();
						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										`🗑️ 已销毁沙盒「${destroyed?.name ?? target}」并清理其隔离目录。`,
										`🗑️ Destroyed sandbox "${destroyed?.name ?? target}" and removed its isolated directory.`,
									),
								},
							],
							details: { action: "destroy", destroyed },
						};
					}
					default:
						return {
							content: [{ type: "text", text: `Unknown sandbox action: ${String(params.action)}` }],
							details: {},
							isError: true,
						};
				}
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: pick(
								lang,
								`沙盒操作失败：${(err as Error).message}`,
								`Sandbox operation failed: ${(err as Error).message}`,
							),
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	};
}
