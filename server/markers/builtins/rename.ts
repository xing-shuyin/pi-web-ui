/**
 * builtins/rename.ts — 重命名当前对话标记。
 *
 * 需求：加个重命名当前对话 marker。
 *
 * 语法：
 *   [[conv:rename:<新标题>]]        重命名当前对话
 *   [[rename:set:<新标题>]]         同上（兼容别名）
 *   [[title:rename:<新标题>]]       同上
 *   [[rename:new:<新标题>]]         同上
 *
 * 兼容：rename 前缀的任意 op 都会被视为重命名，例如 [[rename:set:My Chat]]、
 *       [[rename:to:My Chat]]。标题来自 args[0] + kwargs[text/name/title] 的
 *       拼接，未提供则报错。
 *
 * 持久化：通过宿主回调直接改对话标题（内存 + 磁盘 transcript session_info），
 *         不需要额外状态。
 */

import type { ApplyResult, MarkerTool, ParsedToken, MarkerContext } from "../marker.js";

export const RENAME_NAMESPACE = "conv";

function extractTitle(token: ParsedToken): string {
	// args[0] 是主标题；kwargs 兼容 text/name/title
	const fromArgs = token.args.join(" ").trim();
	const fromKw = (token.kwargs["text"] ?? token.kwargs["name"] ?? token.kwargs["title"] ?? "").trim();
	if (fromArgs && fromKw) return `${fromArgs} ${fromKw}`.trim();
	return fromArgs || fromKw;
}

export const renameMarker: MarkerTool<never> = {
	name: "conv",
	guidance: [
		"- 重命名当前对话：[[conv:rename:<新标题>]]（或 [[rename:set:<标题>]]）。标题尽量简短、能概括本次任务。首次回复用户问题后根据情况重命名当前会话",
	],

	async apply(token: ParsedToken, ctx: MarkerContext): Promise<ApplyResult> {
		if (token.op !== "rename") {
			return { applied: false, error: `conv 未知操作: ${token.op}（当前仅支持 conv:rename）` };
		}
		const title = extractTitle(token);
		if (!title) return { applied: false, error: "conv:rename 需要一个标题参数 [[conv:rename:<新标题>]]" };
		if (title.length > 80) return { applied: false, error: "标题过长（最多 80 字）" };
		if (!ctx.renameConversation) return { applied: false, error: "当前环境不支持重命名" };
		try {
			ctx.renameConversation(title);
			ctx.notify(`已重命名为：${title}`, "info", `Renamed to: ${title}`);
			return { applied: true, feedback: `renamed to "${title}"` };
		} catch (e) {
			return { applied: false, error: `重命名失败: ${(e as Error).message ?? String(e)}` };
		}
	},
	overlay: undefined,
	init: () => undefined as never,
};

/** 别名：[[rename:set:标题]] 等同 [[conv:rename:标题]]，方便模型直觉书写。 */
export const renameAliasMarker: MarkerTool<never> = {
	name: "rename",
	guidance: ["- [[rename:set:<新标题>]] 同 [[conv:rename:<新标题>]]：重命名当前对话。"],
	async apply(token: ParsedToken, ctx: MarkerContext): Promise<ApplyResult> {
		// 兼容任意 op：只要能取到标题就重命名
		const title = extractTitle(token) || token.op?.trim() || "";
		// 若 token 是 [[rename:My Title:]] 形式，op=My Title, args 空 —— 用 op 当标题
		const effective = title || token.op;
		if (!effective?.trim()) return { applied: false, error: "rename 需要标题参数 [[rename:set:<新标题>]]" };
		const trimmed = effective.trim().slice(0, 80);
		if (!ctx.renameConversation) return { applied: false, error: "当前环境不支持重命名" };
		try {
			ctx.renameConversation(trimmed);
			ctx.notify(`已重命名为：${trimmed}`, "info", `Renamed to: ${trimmed}`);
			return { applied: true, feedback: `renamed to "${trimmed}"` };
		} catch (e) {
			return { applied: false, error: `重命名失败: ${(e as Error).message ?? String(e)}` };
		}
	},
	overlay: undefined,
	init: () => undefined as never,
};

/** title 前缀别名：[[title:rename:标题]] */
export const titleAliasMarker: MarkerTool<never> = {
	name: "title",
	guidance: [],
	async apply(token: ParsedToken, ctx: MarkerContext): Promise<ApplyResult> {
		if (token.op !== "rename") return { applied: false, error: `title 未知操作: ${token.op}` };
		const title = extractTitle(token);
		if (!title) return { applied: false, error: "title:rename 需要标题" };
		if (!ctx.renameConversation) return { applied: false, error: "当前环境不支持重命名" };
		ctx.renameConversation(title.slice(0, 80));
		ctx.notify(`已重命名为：${title.slice(0, 80)}`, "info", `Renamed to: ${title.slice(0, 80)}`);
		return { applied: true, feedback: `renamed` };
	},
	overlay: undefined,
	init: () => undefined as never,
};
