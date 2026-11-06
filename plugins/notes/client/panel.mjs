import { createNotesApp } from "./app.mjs";
import { el } from "./dom.mjs";
import { createSettings } from "./settings-form.mjs";
import * as S from "./store.mjs";
import { hostApi } from "@pi-web-ui/plugin-sdk/client";

const POS_KEY = "notes:panel";
const MIN_W = 260;
const MIN_H = 200;

const NOTE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/><path d="M6 14h6"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/></svg>';

function readPos() {
	try {
		const raw = JSON.parse(localStorage.getItem(POS_KEY) ?? "{}");
		if (raw && typeof raw === "object") return raw;
	} catch {}
	return {};
}

function writePos(patch) {
	try {
		localStorage.setItem(POS_KEY, JSON.stringify({ ...readPos(), ...patch }));
	} catch {}
}

export function createPanel(options) {
	const { data, onNotify } = options;
	let t = options.t;
	const saved = readPos();
	const state = {
		open: saved.open === true,
		min: saved.min === true,
		x: Number.isFinite(saved.x) ? saved.x : Math.max(16, window.innerWidth - 376),
		y: Number.isFinite(saved.y) ? saved.y : 64,
		w: Number.isFinite(saved.w) ? saved.w : 360,
		h: Number.isFinite(saved.h) ? saved.h : 440,
	};

	const title = el("span", { class: "nt-panel-title" });
	const pillCount = el("span", { class: "nt-pill-count nt-zero" });
	const pillLabel = el("span", { class: "nt-pill-label" });
	const icon = el("span", { class: "nt-head-icon" });
	try {
		icon.innerHTML = NOTE_SVG;
	} catch {
		icon.textContent = "📓";
	}
	const head = el(
		"div",
		{ class: "nt-panel-head" },
		icon,
		title,
		pillCount,
		pillLabel,
		el("span", { class: "nt-grow" }),
	);

	const settingsBtn = el("button", { type: "button", class: "nt-btn nt-icon nt-pill-hide", text: "⚙" });
	const minBtn = el("button", { type: "button", class: "nt-btn nt-icon", text: "▾" });
	const closeBtn = el("button", { type: "button", class: "nt-btn nt-icon nt-pill-hide", text: "✕" });
	head.append(settingsBtn, minBtn, closeBtn);

	const appHost = el("div", { class: "nt-panel-body" });
	const grip = el("div", { class: "nt-grip", title: "resize" });
	const settingsTitle = el("span", { class: "nt-settings-title", text: t("action.settings") });
	const settingsClose = el("button", { type: "button", class: "nt-btn nt-icon", text: "✕" });
	const settingsPop = el(
		"div",
		{ class: "nt-settings-pop" },
		el("div", { class: "nt-settings-head" }, settingsTitle, el("span", { class: "nt-grow" }), settingsClose),
	);
	const main = el("div", { class: "nt-panel-main" }, appHost, settingsPop);
	const root = el("div", { class: "nt-panel nt-root" }, head, main, grip);
	appendToAnchor();

	let app = null;
	let settingsOpen = false;

	function appendToAnchor() {
		let anchor = null;
		try {
			anchor = hostApi()?.dom?.anchors?.()?.app ?? globalThis.window?.__piWebUiHost?.dom?.anchors?.()?.app ?? null;
		} catch {
			anchor = null;
		}
		(anchor ?? document.body).append(root);
	}

	function apply() {
		const w = Math.min(Math.max(MIN_W, state.w), Math.max(MIN_W, window.innerWidth - 16));
		const h = Math.min(Math.max(MIN_H, state.h), Math.max(MIN_H, window.innerHeight - 16));
		state.x = Math.min(Math.max(8, state.x), Math.max(8, window.innerWidth - w - 8));
		state.y = Math.min(Math.max(8, state.y), Math.max(8, window.innerHeight - 40));
		if (state.min) {
			root.style.width = "";
			root.style.height = "";
		} else {
			root.style.width = `${Math.round(w)}px`;
			root.style.height = `${Math.round(h)}px`;
		}
		root.style.left = `${Math.round(state.x)}px`;
		root.style.top = `${Math.round(state.y)}px`;
		root.style.display = state.open ? "" : "none";
		root.classList.toggle("nt-pill", state.min);
		root.classList.toggle("nt-open", state.open);
		minBtn.textContent = state.min ? "▸" : "▾";
		minBtn.title = state.min ? t("action.restore") : t("action.minimize");
		closeBtn.title = t("action.close");
		settingsBtn.title = t("action.settings");
		settingsTitle.textContent = t("action.settings");
		title.textContent = t("app.title");
	}

	function persist() {
		writePos({ open: state.open, min: state.min, x: state.x, y: state.y, w: state.w, h: state.h });
	}

	let drag = null;
	head.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		if (e.target.closest("button,input,select,textarea,a")) return;
		drag = { mode: "move", dx: e.clientX - state.x, dy: e.clientY - state.y, id: e.pointerId };
		root.classList.add("nt-dragging");
		e.preventDefault();
	});
	grip.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		drag = { mode: "resize", w0: state.w, h0: state.h, x0: e.clientX, y0: e.clientY, id: e.pointerId };
		e.preventDefault();
	});
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", onPointerUp);
	window.addEventListener("pointercancel", onPointerUp);
	window.addEventListener("resize", apply);

	function onPointerMove(e) {
		if (!drag || e.pointerId !== drag.id) return;
		if (drag.mode === "move") {
			state.x = e.clientX - drag.dx;
			state.y = e.clientY - drag.dy;
		} else {
			state.w = Math.max(MIN_W, drag.w0 + (e.clientX - drag.x0));
			state.h = Math.max(MIN_H, drag.h0 + (e.clientY - drag.y0));
		}
		apply();
	}

	function onPointerUp(e) {
		if (!drag || e.pointerId !== drag.id) return;
		drag = null;
		root.classList.remove("nt-dragging");
		persist();
	}

	function ensureApp() {
		if (!app) {
			appHost.textContent = "";
			app = createNotesApp({ root: appHost, data, t, compact: true });
		}
		return app;
	}

	function show(focusQuick = false) {
		state.open = true;
		state.min = false;
		ensureApp();
		apply();
		persist();
		void data.refresh();
		if (focusQuick) app?.focusQuickInput();
	}

	function hide() {
		state.open = false;
		apply();
		persist();
	}

	function minimize() {
		state.min = true;
		apply();
		persist();
	}

	settingsBtn.addEventListener("click", () => {
		settingsOpen = !settingsOpen;
		renderSettings();
	});
	settingsClose.addEventListener("click", () => {
		settingsOpen = false;
		renderSettings();
	});
	minBtn.addEventListener("click", () => {
		if (state.min) show();
		else minimize();
	});
	closeBtn.addEventListener("click", hide);

	const unsubscribe = data.subscribe((snap) => {
		const counts = S.counts(snap.store);
		pillCount.textContent = String(counts.attention);
		pillCount.classList.toggle("nt-zero", counts.attention === 0);
		pillLabel.textContent = counts.attention ? "" : t("app.title");
	});

	const settingsBox = createSettings({
		t,
		data,
		onNotify: (text) => onNotify?.(text),
		extra: [
			el("button", {
				type: "button",
				class: "nt-btn",
				text: t("settings.position"),
				onClick: () => {
					state.x = Math.max(16, window.innerWidth - 376);
					state.y = 64;
					state.w = 360;
					state.h = 440;
					apply();
					persist();
				},
			}),
		],
	});
	settingsPop.append(settingsBox.el);

	function renderSettings() {
		settingsPop.classList.toggle("on", settingsOpen);
		settingsBtn.classList.toggle("on", settingsOpen);
		if (settingsOpen) settingsBox.refresh();
	}

	if (state.open) ensureApp();
	apply();

	return {
		toggle() {
			if (state.open && !state.min) hide();
			else show();
		},
		show: () => show(true),
		hide,
		minimize,
		isOpen: () => state.open && !state.min,
		refreshLabels(nextT) {
			t = nextT;
			if (app) {
				app.destroy();
				app = null;
			}
			if (state.open) ensureApp();
			settingsBox.refresh();
			apply();
		},
		destroy() {
			unsubscribe();
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);
			window.removeEventListener("resize", apply);
			app?.destroy();
			app = null;
			root.remove();
		},
	};
}
