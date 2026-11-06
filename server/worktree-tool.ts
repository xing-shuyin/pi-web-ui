import { Type, type Static } from "typebox";
import { resolve } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { pick, type ServerLang } from "./i18n.js";
import { createWorktree, listWorktrees, normalizeWirePath, removeWorktree } from "./worktree-service.js";

export const WORKTREE_TOOL_NAME = "worktree";

const WorktreeParameters = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("switch"), Type.Literal("remove")], {
		description: "Operation to perform: list | create | switch | remove.",
	}),
	path: Type.Optional(
		Type.String({
			description: "Target directory path for worktree create/switch/remove (relative or absolute).",
		}),
	),
	branch: Type.Optional(
		Type.String({
			description: "Branch name to check out or bind to the worktree.",
		}),
	),
	newBranch: Type.Optional(
		Type.Union([Type.Boolean(), Type.String()], {
			description: "Create and switch to a new branch (boolean true or string branch name).",
		}),
	),
	commit: Type.Optional(
		Type.String({
			description: "Base commit or branch to branch off from.",
		}),
	),
	switchTo: Type.Optional(
		Type.Boolean({
			description: "create: true to switch the active workspace to the new worktree immediately.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description: "remove: true to force removal even if dirty or containing unmerged changes.",
		}),
	),
});

export type WorktreeToolInput = Static<typeof WorktreeParameters>;

export interface WorktreeToolHost {
	getCwd: () => string;
	setCwd: (newCwd: string) => Promise<void>;
	onWorktreeChanged?: () => Promise<void>;
}

export function makeWorktreeTool(
	host: WorktreeToolHost,
	getLang: () => ServerLang,
): ToolDefinition<typeof WorktreeParameters> {
	return {
		name: WORKTREE_TOOL_NAME,
		label: "Manage Git worktrees",
		description:
			"Inspect, create, switch, or remove Git worktrees for isolated branch or PR development. " +
			"Maintains synchronization between the active workspace and git worktree directories.",
		promptSnippet: "manage Git worktrees for isolated PR and branch work",
		promptGuidelines: [
			"Use worktree(action='create') rather than running git worktree add in bash so the workspace UI stays synchronized",
			"Call worktree(action='switch') or pass switchTo=true to change the active workspace to the target worktree",
			"Always inspect worktree(action='list') before moving to a new PR to avoid leaving unmerged changes",
		],
		parameters: WorktreeParameters,
		async execute(toolCallId, params: WorktreeToolInput): Promise<AgentToolResult<unknown>> {
			const lang = getLang();
			const cwd = host.getCwd();

			try {
				switch (params.action) {
					case "list": {
						const list = await listWorktrees(cwd);
						if (list.length === 0) {
							return {
								content: [
									{
										type: "text",
										text: pick(
											lang,
											"当前目录不属于 Git 仓库或暂未发现任何 Git 工作树。",
											"Current directory is not a Git repository or no worktrees found.",
											"worktree.list.empty",
										),
									},
								],
								details: { worktrees: [] },
							};
						}

						const lines: string[] = [];
						lines.push(
							pick(
								lang,
								`共发现 ${list.length} 个 Git 工作树：`,
								`Found ${list.length} Git worktree(s):`,
								"worktree.list.header",
								{ n: list.length },
							),
						);

						for (const item of list) {
							const tags: string[] = [];
							if (item.isMain) tags.push(pick(lang, "主仓库", "main", "worktree.tag.main"));
							if (item.isCurrent) tags.push(pick(lang, "当前工作区", "active", "worktree.tag.current"));
							if (item.isDirty) {
								tags.push(
									pick(
										lang,
										`未提交修改: ${item.uncommittedCount ?? 0} 个文件`,
										`dirty: ${item.uncommittedCount ?? 0} files`,
										"worktree.tag.dirty",
										{ n: item.uncommittedCount ?? 0 },
									),
								);
							}
							if (item.aheadCount && item.aheadCount > 0) {
								tags.push(
									pick(
										lang,
										`领先主分支 ${item.aheadCount} 个提交`,
										`ahead ${item.aheadCount} commit(s)`,
										"worktree.tag.ahead",
										{ n: item.aheadCount },
									),
								);
							}

							const tagStr = tags.length > 0 ? ` [${tags.join(" | ")}]` : "";
							const branchStr = item.branch ? ` (${item.branch})` : "";
							lines.push(`- ${item.path}${branchStr}${tagStr}`);
						}

						return {
							content: [{ type: "text", text: lines.join("\n") }],
							details: { worktrees: list },
						};
					}

					case "create": {
						if (!params.path) {
							throw new Error(
								pick(
									lang,
									"创建工作树必须指定 path 参数",
									"path parameter is required for creating a worktree",
									"worktree.create.missing_path",
								),
							);
						}

						const res = await createWorktree(
							cwd,
							{
								path: params.path,
								branch: params.branch,
								newBranch: params.newBranch,
								commit: params.commit,
							},
							() => lang,
						);

						if (params.switchTo) {
							await host.setCwd(res.path);
						}
						await host.onWorktreeChanged?.();

						const switchedText = params.switchTo
							? pick(
									lang,
									"，并已切换当前工作区至该目录",
									", and switched active workspace to it",
									"worktree.create.switched",
								)
							: "";

						const branchSuffixZh = res.branch ? ` (分支: ${res.branch})` : "";
						const branchSuffixEn = res.branch ? ` (branch: ${res.branch})` : "";
						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										`✅ 成功创建 Git 工作树：${res.path}${branchSuffixZh}${switchedText}`,
										`✅ Successfully created Git worktree: ${res.path}${branchSuffixEn}${switchedText}`,
										"worktree.create.success",
										{ path: res.path, branch: res.branch ?? "", switched: switchedText },
									),
								},
							],
							details: { path: res.path, branch: res.branch, switched: Boolean(params.switchTo) },
						};
					}

					case "switch": {
						if (!params.path) {
							throw new Error(
								pick(
									lang,
									"切换工作树必须指定 path 参数",
									"path parameter is required for switching worktree",
									"worktree.switch.missing_path",
								),
							);
						}

						const target = normalizeWirePath(resolve(cwd, params.path));
						await host.setCwd(target);
						await host.onWorktreeChanged?.();

						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										`🌿 已将当前工作区切换至 Git 工作树：${target}`,
										`🌿 Switched active workspace to Git worktree: ${target}`,
										"worktree.switch.success",
										{ target },
									),
								},
							],
							details: { path: target },
						};
					}

					case "remove": {
						if (!params.path) {
							throw new Error(
								pick(
									lang,
									"移除工作树必须指定 path 参数",
									"path parameter is required for removing worktree",
									"worktree.remove.missing_path",
								),
							);
						}

						const target = normalizeWirePath(resolve(cwd, params.path));
						await removeWorktree(cwd, target, params.force, () => lang);
						await host.onWorktreeChanged?.();

						return {
							content: [
								{
									type: "text",
									text: pick(
										lang,
										`🗑️ 已安全移除 Git 工作树：${target}`,
										`🗑️ Successfully removed Git worktree: ${target}`,
										"worktree.remove.success",
										{ target },
									),
								},
							],
							details: { path: target, removed: true },
						};
					}

					default:
						throw new Error(`Unknown action: ${(params as { action?: string }).action}`);
				}
			} catch (err) {
				const msg = (err as Error).message || String(err);
				return {
					content: [
						{
							type: "text",
							text: pick(
								lang,
								`❌ 操作 Git 工作树失败：${msg}`,
								`❌ Worktree operation failed: ${msg}`,
								"worktree.op.failed",
								{ msg },
							),
						},
					],
					details: { error: msg },
				};
			}
		},
	};
}
