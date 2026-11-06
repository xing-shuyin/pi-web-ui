import { createDataClient } from "./data.mjs";
import { createPanel } from "./panel.mjs";
import { detectLang, makeT } from "./i18n.mjs";
import { ensureStyles } from "./styles.mjs";
import { loadPrefs, onPrefs } from "./prefs.mjs";
import { hostApi } from "@pi-web-ui/plugin-sdk/client";

ensureStyles();

const RUNTIME_KEY = "__piNotesRuntime";
const previous = globalThis[RUNTIME_KEY];
if (previous?.destroy) {
	try {
		previous.destroy();
	} catch (err) {
		console.warn("[notes] 清理上一轮实例失败：", err);
	}
}

function currentLang() {
	const prefs = loadPrefs();
	return prefs.lang === "auto" ? detectLang() : prefs.lang;
}

let lang = currentLang();
let t = makeT(lang);

const data = createDataClient({
	importMetaUrl: import.meta.url,
	onFired: (fresh) => onReminderFired(fresh),
});
data.start();

const panel = createPanel({
	data,
	t,
	onNotify: (text) => toast(text),
});

async function toast(text, withAction = true) {
	try {
		const bridge = hostApi() ?? globalThis.window?.__piWebUiHost;
		if (typeof bridge?.notifyAction !== "function") return;
		const actions = withAction ? [{ id: "open", label: t("notify.view") }] : [];
		const picked = await bridge.notifyAction({ text, actions });
		if (picked === "open") panel.show();
	} catch {}
}

let audioCtx = null;
function beep() {
	try {
		const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
		if (!Ctx) return;
		audioCtx = audioCtx ?? new Ctx();
		if (audioCtx.state === "suspended") void audioCtx.resume();
		const now = audioCtx.currentTime;
		for (const [freq, at] of [
			[880, 0],
			[1320, 0.16],
		]) {
			const osc = audioCtx.createOscillator();
			const gain = audioCtx.createGain();
			osc.frequency.value = freq;
			osc.type = "sine";
			gain.gain.setValueAtTime(0.0001, now + at);
			gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.18);
			osc.connect(gain).connect(audioCtx.destination);
			osc.start(now + at);
			osc.stop(now + at + 0.2);
		}
	} catch {}
}

function desktopNotify(title, body) {
	try {
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		const n = new Notification(title, { body });
		n.onclick = () => {
			try {
				window.focus();
			} catch {}
			panel.show();
			n.close();
		};
	} catch {}
}

function onReminderFired(fresh) {
	const prefs = loadPrefs();
	const list = Array.isArray(fresh) ? fresh : [];
	if (!list.length) return;
	const text =
		list.length === 1
			? `⏰ ${t("notify.title")}：${list[0].text}`
			: `⏰ ${t("notify.many", { n: list.length })}：${list.map((p) => p.text).join("；")}`;
	if (prefs.toast) void toast(text);
	if (prefs.desktop && !document.hasFocus()) desktopNotify(t("notify.title"), list.map((p) => p.text).join("\n"));
	if (prefs.sound) beep();
	if (prefs.autoOpen && !document.hidden) panel.show();
}

const teardown = [];

function whenBridge(fn, tries = 40) {
	const bridge = hostApi() ?? globalThis.window?.__piWebUiHost;
	if (bridge && typeof bridge === "object") {
		fn(bridge);
		return;
	}
	if (tries <= 0) return;
	const timer = setTimeout(() => whenBridge(fn, tries - 1), 250);
	teardown.push(() => clearTimeout(timer));
}

whenBridge((bridge) => {
	try {
		const off = bridge.onUiAction?.("notes:toggle", () => panel.toggle());
		if (typeof off === "function") teardown.push(off);
	} catch {}
	try {
		const off = bridge.shortcuts?.register?.("ctrl+alt+n", () => panel.show());
		if (typeof off === "function") teardown.push(off);
	} catch {}
});

function applyLang(next) {
	if (next === lang) return;
	lang = next;
	t = makeT(lang);
	panel.refreshLabels(t);
}

const offPrefs = onPrefs(() => applyLang(currentLang()));

let langObserver = null;
try {
	langObserver = new MutationObserver(() => {
		if (loadPrefs().lang !== "auto") return;
		applyLang(detectLang());
	});
	langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
} catch {}

globalThis[RUNTIME_KEY] = {
	data,
	panel,
	destroy() {
		for (const off of teardown.splice(0)) {
			try {
				off();
			} catch {}
		}
		try {
			offPrefs();
		} catch {}
		try {
			langObserver?.disconnect();
		} catch {}
		try {
			data.stop();
		} catch {}
		panel.destroy();
	},
};
