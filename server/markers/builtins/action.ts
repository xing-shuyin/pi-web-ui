import type { ApplyResult, MarkerTool, MarkerOverlay, ParsedToken, MarkerContext } from "../marker.js";
import { getServerBlock, pick, type ServerLang } from "../../i18n.js";

export const ACTION_NAMESPACE = "action";

export interface ActionItem {
	id: string;
	label: string;
	prompt: string;
}

export interface ActionState {
	actions: ActionItem[];
	nextId: number;
}

export function initActionState(): ActionState {
	return { actions: [], nextId: 1 };
}

const ACTION_GUIDANCE_ZH: string[] = [
	"- 建议操作按钮：[[action:suggest:<按钮文字>]]（一个标记对应一个按钮；多个选项请输出多个独立标记：[[action:suggest:选项A]] [[action:suggest:选项B]]，切勿合并）。区分发送内容：[[action:suggest:<显示>,prompt=<发送>]]。清空：[[action:clear:all]]。",
];

const ACTION_GUIDANCE_EN: string[] = [
	"- Suggest action buttons: [[action:suggest:<label>]] (one marker per button; for multiple choices output separate markers: [[action:suggest:A]] [[action:suggest:B]], NEVER join options in one marker). Separate prompt: [[action:suggest:<label>,prompt=<text>]]. Clear: [[action:clear:all]].",
];

export function getActionGuidance(lang: ServerLang = "en"): string[] {
	return getServerBlock(lang, "markers.action.guidance", ACTION_GUIDANCE_ZH, ACTION_GUIDANCE_EN);
}

const VALID_ACTION_OPS = new Set(["suggest", "add", "next", "reply", "choice", "option", "action"]);

export const actionMarker: MarkerTool<ActionState> = {
	name: "action",
	guidance: ACTION_GUIDANCE_ZH,
	getGuidance: getActionGuidance,

	async apply(
		token: ParsedToken,
		_ctx: MarkerContext,
		state: ActionState,
		lang: ServerLang = "en",
	): Promise<ApplyResult> {
		const op = token.op.toLowerCase();

		if (op === "clear") {
			state.actions = [];
			return {
				applied: true,
				feedback: pick(lang, "已清空建议操作", "Cleared suggested actions", "markers.action.cleared"),
			};
		}

		if (!VALID_ACTION_OPS.has(op)) {
			return {
				applied: false,
				error: pick(
					lang,
					`action 未知操作: ${token.op}（支持 suggest/next/add/clear）`,
					`action unknown operation: ${token.op} (supports suggest/next/add/clear)`,
					"markers.action.unknown.operation",
					{ "token.op": token.op },
				),
			};
		}

		const argsText = token.args.join(",").trim();
		const kwLabel = token.kwargs["label"]?.trim() || "";
		const kwPrompt = token.kwargs["prompt"]?.trim() || "";
		const kwText = token.kwargs["text"]?.trim() || "";

		let prompt = kwPrompt || argsText || kwText || kwLabel;
		let label = kwLabel || argsText || kwText || prompt;

		if (!label && !prompt) {
			return {
				applied: false,
				error: pick(
					lang,
					"action:suggest 需要操作描述 [[action:suggest:<文字>]]",
					"action:suggest requires an action description [[action:suggest:<text>]]",
					"markers.action.requires.text",
				),
			};
		}

		if (!prompt) prompt = label;
		if (!label) label = prompt;

		if (label.length > 80) label = label.slice(0, 80);
		if (prompt.length > 2000) prompt = prompt.slice(0, 2000);

		const existing = state.actions.find((a) => a.label === label && a.prompt === prompt);
		if (existing) {
			return {
				applied: true,
				feedback: pick(
					lang,
					`建议操作已存在: ${label}`,
					`Suggested action already exists: ${label}`,
					"markers.action.already.exists",
					{ label },
				),
			};
		}

		if (state.actions.length >= 8) {
			state.actions.shift();
		}

		const id = `act-${state.nextId++}`;
		state.actions.push({ id, label, prompt });

		return {
			applied: true,
			feedback: pick(lang, `已添加建议操作: ${label}`, `Added suggested action: ${label}`, "markers.action.added", {
				label,
			}),
		};
	},

	overlay(state: ActionState): MarkerOverlay | undefined {
		if (!state || state.actions.length === 0) return undefined;
		const lines = state.actions.map((a) => (a.label === a.prompt ? ` [${a.label}]` : ` [${a.label}] -> ${a.prompt}`));
		return { tool: "action", lines: [`${state.actions.length} action(s)`, ...lines] };
	},

	init: initActionState,
};

export const suggestMarker: MarkerTool<ActionState> = {
	...actionMarker,
	name: "suggest",
	isAlias: true,
	guidance: [],
	getGuidance: () => [],
};
