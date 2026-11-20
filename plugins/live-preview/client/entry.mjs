import { hostApi } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "./i18n.mjs";

/** 弹窗被拦截时的降级提示走插件词典 t()，语言跟随宿主全局设置。 */
const t = makeT();

const OPEN = "live-preview:open";
const OPEN_MD = "live-preview:open-md";

function appRoot() {
	try {
		const u = new URL(import.meta.url);
		const i = u.pathname.indexOf("/plugins/");
		return `${u.origin}${i >= 0 ? u.pathname.slice(0, i) : ""}`;
	} catch {
		return "";
	}
}

function encPath(p) {
	return String(p ?? "")
		.split("/")
		.filter((s) => s && s !== "." && s !== "..")
		.map(encodeURIComponent)
		.join("/");
}

function parentDir(wire) {
	const segs = encPath(wire).split("/").filter(Boolean);
	segs.pop();
	return segs.join("/");
}

function openTab(prefix, rel, isDir) {
	let url = `${appRoot()}${prefix}/`;
	if (rel) url += `${encPath(rel)}${isDir ? "/" : ""}`;
	try {
		const opened = window.open(url, "_blank", "noopener");
		// 浏览器拦弹窗时跳转静默失败，给一句控制台提示（服务端返回的正文里本就有可点的链接）。
		if (!opened) console.warn(`[live-preview] ${t("openBlocked")}`);
	} catch {}
}

function onOpen(_itemId, _value, target) {
	const kind = String(target?.kind ?? "list");
	const id = String(target?.id ?? "");
	if (kind === "dir" && id) openTab("/liveserver", id, true);
	else if (kind === "file" && id) openTab("/liveserver", parentDir(id), true);
	else openTab("/liveserver", id, true);
}

function onOpenMd(_itemId, _value, target) {
	const kind = String(target?.kind ?? "list");
	const id = String(target?.id ?? "");
	if (kind === "file" && /\.md$/i.test(id)) {
		openTab("/md", id, false);
		return;
	}
	onOpen(_itemId, _value, target);
}

function register() {
	try {
		const api = hostApi();
		api?.onUiAction?.(OPEN, onOpen);
		api?.onUiAction?.(OPEN_MD, onOpenMd);
	} catch {}
}

register();

export default {
	mount() {
		register();
		return () => {};
	},
};
