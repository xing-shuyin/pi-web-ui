import type { UiAlign, UiLayoutPrefs, UiSlotId } from "./protocol.js";
import { UI_SLOTS } from "./plugin-ui-slots.js";

export function normalizeUiLayout(v: unknown): UiLayoutPrefs {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const o = v as Record<string, unknown>;
	const arr = (x: unknown, max: number): string[] | undefined => {
		if (!Array.isArray(x)) return undefined;
		const out = [
			...new Set(x.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 96)),
		].slice(0, max);
		return out.length ? out : undefined;
	};
	const dict = (x: unknown, max: number): Record<string, string> | undefined => {
		if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
		const out: Record<string, string> = {};
		for (const [k, val] of Object.entries(x as Record<string, unknown>).slice(0, max)) {
			if (k.length > 0 && k.length <= 96 && typeof val === "string" && val.length > 0 && val.length <= 120) {
				out[k] = val;
			}
		}
		return Object.keys(out).length ? out : undefined;
	};
	const BRAND_NEW = "host:brand";
	const isBrandOld = (id: string): boolean => id === "host:brand-logo" || id === "host:brand-name";
	const mapBrandList = (list: string[] | undefined): string[] | undefined => {
		if (!list) return undefined;
		const out: string[] = [];
		for (const id of list) {
			const mapped = isBrandOld(id) ? BRAND_NEW : id;
			if (!out.includes(mapped)) out.push(mapped);
		}
		return out.length ? out : undefined;
	};
	const foldBrandDict = (
		src: Record<string, string> | undefined,
		logoFirst: boolean,
	): Record<string, string> | undefined => {
		if (!src) return undefined;
		const out: Record<string, string> = {};
		for (const [k, val] of Object.entries(src)) {
			if (isBrandOld(k)) continue;
			out[k] = val;
		}
		if (out[BRAND_NEW] === undefined) {
			const picked = logoFirst
				? (src["host:brand-logo"] ?? src["host:brand-name"])
				: (src["host:brand-name"] ?? src["host:brand-logo"]);
			if (picked !== undefined) out[BRAND_NEW] = picked;
		}
		return Object.keys(out).length ? out : undefined;
	};
	const hidden = mapBrandList(arr(o.hidden, 200));
	const shown = mapBrandList(arr(o.shown, 200));
	const order = mapBrandList(arr(o.order, 200));
	const groups = foldBrandDict(dict(o.groups, 200), true);
	const labels = foldBrandDict(dict(o.labels, 200), false);
	let align: Record<string, UiAlign> | undefined;
	if (o.align && typeof o.align === "object" && !Array.isArray(o.align)) {
		align = {};
		for (const [k, val] of Object.entries(o.align as Record<string, unknown>).slice(0, 200)) {
			if (k.length > 0 && k.length <= 96 && (val === "start" || val === "center" || val === "end")) {
				align[k] = val;
			}
		}
		if (Object.keys(align).length === 0) align = undefined;
	}
	if (align && ("host:brand-logo" in align || "host:brand-name" in align)) {
		const out: Record<string, UiAlign> = {};
		for (const [k, val] of Object.entries(align)) {
			if (k === "host:brand-logo" || k === "host:brand-name") continue;
			out[k] = val;
		}
		if (out[BRAND_NEW] === undefined) {
			const picked = align["host:brand-logo"] ?? align["host:brand-name"];
			if (picked !== undefined) out[BRAND_NEW] = picked;
		}
		align = Object.keys(out).length ? out : undefined;
	}
	const topbarText = typeof o.topbarText === "boolean" ? (o.topbarText as boolean) : undefined;
	const sideDockFloat = typeof o.sideDockFloat === "boolean" ? (o.sideDockFloat as boolean) : undefined;
	let slots: Record<string, UiSlotId> | undefined;
	if (o.slots && typeof o.slots === "object" && !Array.isArray(o.slots)) {
		slots = {};
		for (const [k, val] of Object.entries(o.slots as Record<string, unknown>).slice(0, 200)) {
			if (k.length > 0 && k.length <= 96 && typeof val === "string" && UI_SLOTS.has(val)) {
				slots[k] = val as UiSlotId;
			}
		}
		if (Object.keys(slots).length === 0) slots = undefined;
	}
	if (slots && ("host:brand-logo" in slots || "host:brand-name" in slots)) {
		const out: Record<string, UiSlotId> = {};
		for (const [k, val] of Object.entries(slots)) {
			if (k === "host:brand-logo" || k === "host:brand-name") continue;
			out[k] = val;
		}
		if (out[BRAND_NEW] === undefined) {
			const picked = slots["host:brand-logo"] ?? slots["host:brand-name"];
			if (picked !== undefined) out[BRAND_NEW] = picked;
		}
		slots = Object.keys(out).length ? out : undefined;
	}
	return {
		...(hidden ? { hidden } : {}),
		...(shown ? { shown } : {}),
		...(order ? { order } : {}),
		...(groups ? { groups } : {}),
		...(align ? { align } : {}),
		...(labels ? { labels } : {}),
		...(topbarText !== undefined ? { topbarText } : {}),
		...(sideDockFloat !== undefined ? { sideDockFloat } : {}),
		...(slots ? { slots } : {}),
	};
}

export const DEFAULT_UI_LAYOUT: UiLayoutPrefs = Object.freeze({
	hidden: [
		"host:browser",
		"host:sound",
		"host:language",
		"notes:__view",
		"voice-input:camera",
		"host:update",
		"host:new-ephemeral-chat",
		"host:open-project",
		"host:search",
		"browser-use:__view",
		"office:__view",
	],
	shown: [
		"host:cwd",
		"host:tasks",
		"host:chat",
		"host:settings",
		"notes:toggle",
		"host:github",
		"run-trace:__view",
		"host:files",
		"host:history",
		"host:theme",
		"pm2-manager:__view",
		"sftp:__view",
		"webmail:__view",
		"host:terminal",
		"image-gen:__view",
		"image-toolkit:__view",
		"host:brand",
		"doubao-tts:__view",
		"tts:__view",
		"approval-gate:__view",
		"tunnel:__view",
		"legado-web:__view",
		"vscode-editor:__view",
		"qq:__view",
		"office-preview:__view",
		"univer-office:__view",
		"office:__view",
		"bili-scroll:__view",
		"wechat-ilink:__view",
	],
	order: [
		"notes:__view",
		"host:msg-copy",
		"host:msg-copy-text",
		"host:msg-copy-markdown",
		"host:msg-copy-image",
		"host:msg-edit-reask",
		"host:history",
		"host:files",
		"host:composer-upload",
		"voice-input:mic",
		"voice-input:camera",
		"host:composer-templates",
		"host:composer-model",
		"host:composer-thinking",
		"host:composer-send",
		"pm2-manager:open-manager",
		"host:github",
		"host:host-metrics",
		"host:cwd",
		"host:conn",
		"host:ctx",
		"host:msg-count",
		"host:cost",
		"host:cache",
		"sol-savings:sol-savings-badge",
		"host:status-delegate",
		"host:working",
		"host:plugin-status",
		"notes:toggle",
		"host:engine",
		"vscode-editor:__view",
		"approval-gate:__view",
		"legado-web:__view",
		"tunnel:__view",
		"image-toolkit:__view",
		"run-trace:__view",
		"wallpaper-engine:toggle",
		"feishu:feishu-open",
		"dingtalk:dingtalk-open",
		"telegram:telegram-open",
		"wecom:wecom-open",
		"discord:discord-open",
		"whatsapp:whatsapp-open",
		"slack:slack-open",
		"qq:qq-open",
		"imessage:imessage-open",
		"matrix:matrix-open",
		"tts:__view",
		"host:zen-mode",
		"wechat-ilink:__view",
		"office:__view",
		"sftp:__view",
		"webmail:__view",
		"host:new-sandbox",
		"bili-scroll:__view",
		"qq:__view",
		"host:canvas",
		"live2d:toggle",
		"host:brand",
		"host:new-chat",
		"host:chat",
		"host:terminal",
		"host:git",
		"host:theme",
		"host:plugins",
		"host:tasks",
		"host:settings",
	],
	align: {
		"host:chat": "start",
		"host:history": "start",
		"host:new-chat": "start",
		"host:files": "start",
		"host:open-project": "center",
		"notes:toggle": "start",
		"host:new-ephemeral-chat": "center",
		"host:terminal": "start",
		"host:git": "start",
		"host:plugins": "start",
		"run-trace:__view": "end",
		"host:github": "end",
		"host:update": "center",
		"host:theme": "start",
		"host:language": "center",
		"host:sound": "center",
		"host:settings": "start",
		"host:tasks": "start",
		"host:browser": "center",
		"host:search": "center",
		"host:brand": "start",
		"host:conn": "start",
		"host:msg-count": "start",
		"office:__view": "end",
	} as Record<string, UiAlign>,
	topbarText: false,
	sideDockFloat: false,
	slots: {
		"host:chat": "topbar.primary",
		"host:conn": "bottombar",
		"host:working": "bottombar",
		"host:plugin-status": "bottombar",
		"host:ctx": "bottombar",
		"host:msg-count": "bottombar",
		"notes:toggle": "bottombar",
		"host:github": "bottombar",
		"host:engine": "bottombar",
		"sftp:__view": "topbar.primary",
		"office:__view": "topbar.primary",
	} as Record<string, UiSlotId>,
});
