import type { ApplyResult, MarkerTool, ParsedToken, MarkerContext } from "../marker.js";
import { getServerBlock, pick, type ServerLang } from "../../i18n.js";

function extractTitle(token: ParsedToken): string {
	const fromArgs = token.args.join(" ").trim();
	const fromKw = (token.kwargs["text"] ?? token.kwargs["name"] ?? token.kwargs["title"] ?? "").trim();
	if (fromArgs && fromKw) return `${fromArgs} ${fromKw}`.trim();
	return fromArgs || fromKw;
}

const RENAME_GUIDANCE_ZH: string[] = ["- 重命名对话：[[conv:rename:<新标题>]]（明确意图后尽早调用一次）。"];

const RENAME_GUIDANCE_EN: string[] = [
	"- Rename conversation: [[conv:rename:<title>]] (call once early when user intent is clear).",
];

export function getRenameGuidance(lang: ServerLang = "en"): string[] {
	return getServerBlock(lang, "markers.rename.guidance", RENAME_GUIDANCE_ZH, RENAME_GUIDANCE_EN);
}
export const renameMarker: MarkerTool<never> = {
	name: "conv",
	guidance: RENAME_GUIDANCE_ZH,
	getGuidance: getRenameGuidance,

	async apply(token: ParsedToken, ctx: MarkerContext, _state: never, lang: ServerLang = "en"): Promise<ApplyResult> {
		if (token.op !== "rename") {
			return {
				applied: false,
				error: pick(
					lang,
					`conv 未知操作: ${token.op}（当前仅支持 conv:rename）`,
					`conv unknown operation: ${token.op} (only conv:rename is supported)`,
					"markers.rename.unknown.operation",
					{ "token.op": token.op },
				),
			};
		}
		const title = extractTitle(token);
		if (!title)
			return {
				applied: false,
				error: pick(
					lang,
					"conv:rename 需要一个标题参数 [[conv:rename:<新标题>]]",
					"conv:rename requires a title argument [[conv:rename:<new title>]]",
					"markers.rename.requires.title",
				),
			};
		if (title.length > 80)
			return {
				applied: false,
				error: pick(
					lang,
					"标题过长（最多 80 字）",
					"Title too long (max 80 characters)",
					"markers.rename.title.too.long",
				),
			};
		if (!ctx.renameConversation)
			return {
				applied: false,
				error: pick(
					lang,
					"当前环境不支持重命名",
					"Renaming is not supported in this environment",
					"markers.rename.not.supported",
				),
			};
		try {
			ctx.renameConversation(title);
			ctx.notify(`已重命名为：${title}`, "info", `Renamed to: ${title}`);
			return {
				applied: true,
				feedback: pick(lang, `已重命名为“${title}”`, `renamed to "${title}"`, "markers.rename.renamed.to", {
					title: title,
				}),
			};
		} catch (e) {
			const errMsg = (e as Error).message ?? String(e);
			return {
				applied: false,
				error: pick(lang, `重命名失败: ${errMsg}`, `Rename failed: ${errMsg}`, "markers.rename.rename.failed", {
					errMsg: errMsg,
				}),
			};
		}
	},
	overlay: undefined,
	init: () => undefined as never,
};
