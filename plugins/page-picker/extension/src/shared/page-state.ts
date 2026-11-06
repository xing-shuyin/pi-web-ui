/// <reference lib="dom" />
import { getMessage } from "./i18n.js";

export interface PageState {
	origin: string;
	authorized: boolean;
	title?: string;
	aiControl: boolean;
}

export interface GrantView {
	status: string;
	kind: "ok" | "warn" | "err" | "info";
	label: string;
	done: boolean;
	hint: string;
}

export function grantView(state: PageState | null | undefined): GrantView {
	if (state === undefined) {
		return {
			status: getMessage("grant_checking_status", undefined, "检查授权状态…"),
			kind: "info",
			label: getMessage("grant_checking_label", undefined, "让 AI 操作本页…"),
			done: false,
			hint: getMessage("grant_checking_hint", undefined, "正在问扩展后台：本页有没有被授权给模型操作"),
		};
	}
	if (state === null) {
		return {
			status: getMessage("grant_null_status", undefined, "查不到授权状态"),
			kind: "info",
			label: getMessage("grant_null_label", undefined, "让 AI 操作本页…"),
			done: false,
			hint: getMessage(
				"grant_null_hint",
				undefined,
				"扩展后台没响应（它可能刚被回收）—— 仍然可以点，授权在扩展设置页完成",
			),
		};
	}
	if (!state.origin) {
		return {
			status: getMessage("grant_notHttp_status", undefined, "本页不是 http/https"),
			kind: "warn",
			label: getMessage("grant_notHttp_label", undefined, "让 AI 操作本页…"),
			done: false,
			hint: getMessage(
				"grant_notHttp_hint",
				undefined,
				"模型只能操作普通网页（http/https）—— 浏览器内部页、扩展页、本地文件都不行",
			),
		};
	}
	if (!state.authorized) {
		return {
			status: getMessage("grant_unauthorized_status", undefined, "未授权"),
			kind: "warn",
			label: getMessage("grant_unauthorized_label", undefined, "让 AI 操作本页…"),
			done: false,
			hint: getMessage(
				"grant_unauthorized_hint",
				[state.origin],
				`让模型在对话里读写 ${state.origin}（可随时在扩展设置页收回）—— 授权要在扩展自己的页面里点一下`,
			),
		};
	}
	const named = state.title && state.title !== state.origin ? `「${state.title}」` : state.origin;
	if (!state.aiControl) {
		return {
			status: getMessage("grant_authorizedSwitchOff_status", undefined, "已授权 · 总开关关着"),
			kind: "warn",
			label: getMessage("grant_authorizedSwitchOff_label", undefined, "已授权 · 打开设置页"),
			done: true,
			hint: getMessage(
				"grant_authorizedSwitchOff_hint",
				[named],
				`${named} 已授权，但扩展设置页里的「允许 AI 操作页面」总开关是关着的 —— 打开它模型才能动手`,
			),
		};
	}
	return {
		status: getMessage("grant_authorizedOn_status", undefined, "已授权 · 模型可操作本页"),
		kind: "ok",
		label: getMessage("grant_authorizedOn_label", undefined, "已授权 · 打开设置页"),
		done: true,
		hint: getMessage(
			"grant_authorizedOn_hint",
			[named],
			`${named} 已授权：在对话里让模型操作这个页面即可（工具 browser_page）；收回授权在扩展设置页`,
		),
	};
}
