import { hostApi, apiBase as getSharedApiBase } from "@pi-web-ui/plugin-sdk/client";
import { makeT } from "./i18n.mjs";

/** UI copy: language resolution / fallback / interpolation live in the SDK; this only reads the active locale. */
const t = makeT();

const ACTION = "voice-input:toggle";
const MAX_RECORD_MS = 5 * 60 * 1000;
const MAX_SR_RESTARTS = 2;

function apiBase() {
	return getSharedApiBase("voice-input");
}

export function srExplain(code) {
	const c = String(code || "");
	if (c === "not-allowed" || c === "service-not-allowed") return { msg: t("micDenied"), kind: "denied" };
	if (c === "network") return { msg: t("srNetwork"), kind: "network" };
	if (c === "no-speech") return { msg: t("srNoSpeech"), kind: "nospeech" };
	if (c === "audio-capture") return { msg: t("srNoSpeech"), kind: "nospeech" };
	if (c === "aborted") return { msg: t("empty"), kind: "aborted" };
	if (c === "language-not-supported") return { msg: t("noSpeech"), kind: "unsupported" };
	return { msg: t("srUnknown", { code: c || "unknown" }), kind: "other" };
}

export function resolveActiveEngine(cfg, mode) {
	if (mode === "sr") return "sr";
	const eng = String(cfg?.engine || "auto").toLowerCase();
	if (eng === "remote") return "remote";
	if (eng === "local") return "local";
	if (cfg?.localReady) return "local";
	if (cfg?.serverReady) return "remote";
	return "local";
}

export function engineBadgeText(engineId, options = {}) {
	const tt = makeT(options.isZh === undefined ? undefined : options.isZh ? "zh" : "en");
	const id = String(engineId || "").toLowerCase();
	if (id === "sr") return tt("badgeSr");
	if (id === "remote") return tt("badgeRemote");
	// localModel is a settings model id (base/tiny/small) — data, interpolated as-is
	return tt("badgeLocal", { model: options.localModel || "base" });
}

export function computeAudioRms(frames) {
	if (!frames || !frames.length) return 0;
	let sum = 0;
	for (let i = 0; i < frames.length; i++) {
		const v = frames[i];
		sum += v * v;
	}
	return Math.sqrt(sum / frames.length);
}

export function audioLevelFromRms(rms) {
	if (typeof rms !== "number" || Number.isNaN(rms) || rms <= 0) return 0;
	const level = Math.min(1, Math.max(0, rms * 4.5));
	return Math.round(level * 100) / 100;
}

export function encodeWavPCM(mono, sampleRate) {
	const sr = Math.floor(sampleRate) || 16000;
	const n = mono.length;
	const buf = new ArrayBuffer(44 + n * 2);
	const v = new DataView(buf);
	const wstr = (o, s) => {
		for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
	};
	wstr(0, "RIFF");
	v.setUint32(4, 36 + n * 2, true);
	wstr(8, "WAVE");
	wstr(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, sr, true);
	v.setUint32(28, sr * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	wstr(36, "data");
	v.setUint32(40, n * 2, true);
	for (let i = 0; i < n; i++) {
		const s = Math.max(-1, Math.min(1, mono[i]));
		v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
	}
	return new Uint8Array(buf);
}

function concatMono(blocks) {
	let total = 0;
	for (const b of blocks) total += b.length;
	const out = new Float32Array(total);
	let off = 0;
	for (const b of blocks) {
		out.set(b, off);
		off += b.length;
	}
	return out;
}

function downmix(channels) {
	if (!channels.length) return new Float32Array(0);
	if (channels.length === 1) return channels[0].slice();
	const len = Math.max(...channels.map((c) => c.length));
	const out = new Float32Array(len);
	for (const c of channels) for (let i = 0; i < c.length; i++) out[i] += c[i] / channels.length;
	return out;
}

function resampleTo16k(samples, fromRate) {
	if (!samples.length) return samples;
	if (Math.round(fromRate) === 16000) return samples.slice();
	const outLen = Math.max(1, Math.round((samples.length * 16000) / fromRate));
	const out = new Float32Array(outLen);
	const ratio = samples.length / outLen;
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const i0 = Math.floor(pos);
		const i1 = Math.min(i0 + 1, samples.length - 1);
		const f = pos - i0;
		out[i] = samples[i0] * (1 - f) + samples[i1] * f;
	}
	return out;
}

let settingsCache = null;
let settingsAt = 0;
async function getSettings() {
	if (settingsCache && Date.now() - settingsAt < 60_000) return settingsCache;
	const d = await fetch(`${apiBase()}/settings`, { credentials: "same-origin" }).then((r) => {
		if (!r.ok) throw new Error(`settings ${r.status}`);
		return r.json();
	});
	settingsCache = {
		// lang is a recognition language code sent to SpeechRecognition.lang and ?lang= (data, not UI copy)
		lang: d.lang || "zh-CN",
		serverFallback: d.serverFallback !== false,
		engine: d.engine || "auto",
		localModel: d.localModel || "base",
		serverReady: !!d.serverReady,
		localReady: !!d.localReady,
	};
	settingsAt = Date.now();
	return settingsCache;
}

function getAccentContrastColor() {
	try {
		const hostVal = getComputedStyle(document.documentElement).getPropertyValue("--accent-contrast")?.trim();
		if (hostVal) return hostVal;

		const probe = document.createElement("div");
		probe.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;color:var(--accent,#7c5cff);";
		document.body.append(probe);
		const comp = getComputedStyle(probe).color;
		probe.remove();

		const m = comp.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
		if (m) {
			const r = Number(m[1]) / 255;
			const g = Number(m[2]) / 255;
			const b = Number(m[3]) / 255;
			const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			return lum > 0.55 ? "#111111" : "#ffffff";
		}
	} catch {}
	return "#ffffff";
}

function findAnchorButton(actionName = ACTION) {
	try {
		let btn = document.querySelector(`button[data-action="${actionName}"]`);
		if (btn && btn.offsetParent !== null) return btn;

		const slotId = actionName === CAM_ACTION ? "camera" : "mic";
		btn = document.querySelector(`button[data-plugin-slot-id="${slotId}"]`);
		if (btn && btn.offsetParent !== null) return btn;

		// Selector vocabulary for the host composer buttons (aria-label/title match), not UI copy:
		// the Chinese words match the zh host UI, the English words the en host UI.
		const kw = actionName === CAM_ACTION ? ["拍照", "相机", "Camera", "Photo"] : ["语音", "麦克风", "Voice", "Mic"];
		for (const k of kw) {
			const candidate = document.querySelector(
				`.inputbox button[aria-label*="${k}" i], .inputbox button[title*="${k}" i]`,
			);
			if (candidate && candidate.offsetParent !== null) return candidate;
		}

		const allPluginBtns = document.querySelectorAll(".inputbox .btn.composer-plugin-action");
		if (allPluginBtns.length > 0) {
			const idx = actionName === CAM_ACTION && allPluginBtns.length > 1 ? 1 : 0;
			return allPluginBtns[idx] || allPluginBtns[0];
		}

		const composer = document.querySelector(".inputbox") || document.querySelector(".composer-tools");
		if (composer) return composer;
	} catch {}
	return null;
}

function positionOverlayToAnchor(panelEl, actionName = ACTION) {
	if (!panelEl) return;
	const anchor = findAnchorButton(actionName);
	if (!anchor) {
		panelEl.style.left = "50%";
		panelEl.style.top = "auto";
		panelEl.style.bottom = "132px";
		panelEl.style.transform = "translateX(-50%)";
		return;
	}

	const aRect = anchor.getBoundingClientRect();
	const pRect = panelEl.getBoundingClientRect();
	const w = pRect.width || 360;
	const h = pRect.height || 110;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const margin = 10;
	const gap = 8;

	let x = aRect.left - 6;
	if (x + w > vw - margin) {
		x = vw - margin - w;
	}
	if (x < margin) {
		x = margin;
	}

	const fitsAbove = aRect.top - h - gap >= margin;
	const fitsBelow = aRect.bottom + gap + h <= vh - margin;

	if (fitsAbove || !fitsBelow) {
		const bottom = Math.max(margin, Math.round(vh - aRect.top + gap));
		panelEl.style.bottom = `${bottom}px`;
		panelEl.style.top = "auto";
	} else {
		const top = Math.max(margin, Math.round(aRect.bottom + gap));
		panelEl.style.top = `${top}px`;
		panelEl.style.bottom = "auto";
	}

	panelEl.style.left = `${Math.round(x)}px`;
	panelEl.style.transform = "none";
}

let overlay = null;
let overlayTimer = 0;
let overlayScrollHandler = null;
let overlayResizeObserver = null;

function cleanupOverlayPositioner() {
	if (overlayScrollHandler) {
		window.removeEventListener("resize", overlayScrollHandler);
		window.removeEventListener("scroll", overlayScrollHandler, true);
		overlayScrollHandler = null;
	}
	if (overlayResizeObserver) {
		overlayResizeObserver.disconnect();
		overlayResizeObserver = null;
	}
}

function closeOverlay() {
	cleanupOverlayPositioner();
	if (overlayTimer) {
		clearInterval(overlayTimer);
		overlayTimer = 0;
	}
	if (overlay) {
		overlay.remove();
		overlay = null;
	}
}

function openOverlay() {
	closeOverlay();
	if (overlayTimer) {
		clearInterval(overlayTimer);
		overlayTimer = 0;
	}
	const root = document.createElement("div");
	root.className = "vi-overlay";
	root.style.setProperty("--accent-contrast", getAccentContrastColor());
	root.style.visibility = "hidden";
	root.innerHTML = `
<style>
	.vi-overlay {
		position: fixed;
		z-index: 9999; min-width: 300px; max-width: min(560px, calc(100vw - 24px));
		background: var(--bg-elev, #16161d); color: inherit;
		border: 1px solid var(--border, #333); border-radius: 12px;
		padding: 12px 14px; font-size: 13px;
		box-shadow: 0 8px 32px rgba(0,0,0,.45);
	}
	.vi-row { display: flex; align-items: center; gap: 8px; }
	.vi-dot { width: 10px; height: 10px; border-radius: 50%; background: #e5484d; flex: none;
		animation: vi-pulse 1.2s ease-in-out infinite; }
	@keyframes vi-pulse { 50% { opacity: .25; } }
	.vi-status { opacity: .75; }
	.vi-badge {
		font-size: 11px; padding: 1px 6px; border-radius: 4px;
		background: var(--chip-bg, rgba(255,255,255,.08));
		border: 1px solid var(--border, #333);
		opacity: .85; flex: none; white-space: nowrap;
	}
	.vi-meter {
		width: 48px; height: 8px; background: rgba(255,255,255,.1);
		border-radius: 4px; overflow: hidden; flex: none; display: flex; align-items: center;
	}
	.vi-meter-bar {
		width: 0%; height: 100%; background: #10b981;
		border-radius: 4px; transition: width .08s ease-out;
	}
	.vi-time { margin-left: auto; opacity: .55; font-variant-numeric: tabular-nums; }
	.vi-text { margin: 8px 0 10px; max-height: 120px; overflow-y: auto;
		white-space: pre-wrap; line-height: 1.6; }
	.vi-text:empty { display: none; }
	.vi-btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
	.vi-btns button {
		border: 1px solid var(--border, #333); border-radius: 6px;
		background: transparent; color: inherit; font: inherit;
		padding: 5px 14px; cursor: pointer;
	}
	.vi-btns button:disabled { opacity: .45; cursor: default; }
	.vi-btns .primary {
		background: var(--accent, #7c5cff);
		border-color: transparent;
		color: var(--accent-contrast, #fff);
		font-weight: 500;
	}
	.vi-btns .primary:hover:not(:disabled) { filter: brightness(0.92); }
	.vi-err { color: #e5484d; }
	.vi-note { opacity: .65; font-size: 12px; margin: 6px 0 2px; line-height: 1.6; }
</style>
<div class="vi-row">
	<span class="vi-dot"></span>
	<span class="vi-status"></span>
	<span class="vi-badge" style="display:none"></span>
	<div class="vi-meter" style="display:none"><div class="vi-meter-bar"></div></div>
	<span class="vi-time"></span>
</div>
<div class="vi-text"></div>
<div class="vi-note" style="display:none"></div>
<div class="vi-btns"></div>`;
	document.body.append(root);
	const statusEl = root.querySelector(".vi-status");
	const badgeEl = root.querySelector(".vi-badge");
	const meterEl = root.querySelector(".vi-meter");
	const meterBarEl = root.querySelector(".vi-meter-bar");
	const textEl = root.querySelector(".vi-text");
	const noteEl = root.querySelector(".vi-note");
	const timeEl = root.querySelector(".vi-time");
	const btnsEl = root.querySelector(".vi-btns");
	overlay = root;

	const updatePos = () => {
		if (overlay) positionOverlayToAnchor(overlay, ACTION);
	};
	updatePos();
	root.style.visibility = "";

	overlayScrollHandler = updatePos;
	window.addEventListener("resize", updatePos, { passive: true });
	window.addEventListener("scroll", updatePos, { capture: true, passive: true });

	if (typeof ResizeObserver !== "undefined") {
		overlayResizeObserver = new ResizeObserver(() => {
			updatePos();
		});
		overlayResizeObserver.observe(root);
	}

	const t0 = Date.now();
	overlayTimer = setInterval(() => {
		if (!overlay) {
			clearInterval(overlayTimer);
			overlayTimer = 0;
			return;
		}
		const s = Math.floor((Date.now() - t0) / 1000);
		timeEl.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
	}, 500);
	return {
		setStatus(s) {
			statusEl.textContent = s;
			requestAnimationFrame(updatePos);
		},
		setBadge(s) {
			if (!badgeEl) return;
			if (!s) {
				badgeEl.style.display = "none";
				badgeEl.textContent = "";
			} else {
				badgeEl.style.display = "";
				badgeEl.textContent = s;
			}
			requestAnimationFrame(updatePos);
		},
		setLevel(val) {
			if (!meterEl || !meterBarEl) return;
			if (val === null || val === undefined || val < 0) {
				meterEl.style.display = "none";
			} else {
				meterEl.style.display = "";
				const pct = Math.min(100, Math.max(0, Math.round(val * 100)));
				meterBarEl.style.width = `${pct}%`;
				if (pct > 70) meterBarEl.style.background = "#e5484d";
				else if (pct > 25) meterBarEl.style.background = "#10b981";
				else meterBarEl.style.background = "#3b82f6";
			}
		},
		setText(s, isErr = false) {
			textEl.textContent = s;
			textEl.classList.toggle("vi-err", isErr);
			requestAnimationFrame(updatePos);
		},
		setNote(s) {
			if (!s) {
				noteEl.style.display = "none";
				noteEl.textContent = "";
			} else {
				noteEl.style.display = "";
				noteEl.textContent = s;
			}
			requestAnimationFrame(updatePos);
		},
		setButtons(btns) {
			btnsEl.innerHTML = "";
			for (const b of btns) {
				const el = document.createElement("button");
				el.type = "button";
				el.textContent = b.label;
				if (b.primary) el.className = "primary";
				if (b.disabled) el.disabled = true;
				el.addEventListener("click", b.onClick);
				btnsEl.append(el);
			}
			requestAnimationFrame(updatePos);
		},
	};
}

export function srTotalText(finalText, interim) {
	return `${String(finalText ?? "")}${String(interim ?? "")}`.trim();
}

const session = {
	mode: "idle",
	recognition: null,
	finalText: "",
	interim: "",
	manualStop: false,
	switching: false,
	srRestarts: 0,
	ui: null,
	rec: null,
};

function resetSession() {
	try {
		session.recognition?.abort();
	} catch {}
	try {
		session.rec?.cleanup();
	} catch {}
	session.mode = "idle";
	session.recognition = null;
	session.rec = null;
	session.finalText = "";
	session.interim = "";
	session.manualStop = false;
	session.switching = false;
	session.srRestarts = 0;
}

function tryComposeText(t) {
	try {
		return hostApi()?.compose({ text: t }) ?? false;
	} catch {
		return false;
	}
}

function trySendDirect(t) {
	try {
		const fn = hostApi()?.startChat;
		if (typeof fn !== "function") return false;
		return fn.call(hostApi(), { prompt: t, newChat: false }) ?? false;
	} catch {
		return false;
	}
}

async function sendDirectText(text, engineBadge = "") {
	const t = String(text ?? "").trim();
	resetSession();
	if (!t) {
		const ui = openOverlay();
		ui.setStatus("🎤");
		if (engineBadge) ui.setBadge(engineBadge);
		ui.setText(t("empty"), true);
		ui.setButtons([{ label: t("close"), primary: true, onClick: closeOverlay }]);
		setTimeout(closeOverlay, 2500);
		return;
	}
	if (trySendDirect(t)) {
		closeOverlay();
		return;
	}
	if (tryComposeText(t)) {
		const ui = openOverlay();
		ui.setStatus("🎤");
		if (engineBadge) ui.setBadge(engineBadge);
		ui.setText(t);
		ui.setNote(t("sendFailed"));
		ui.setButtons([{ label: t("close"), primary: true, onClick: closeOverlay }]);
		setTimeout(closeOverlay, 3000);
		return;
	}
	const ui = openOverlay();
	ui.setStatus("🎤");
	if (engineBadge) ui.setBadge(engineBadge);
	ui.setText(t);
	ui.setButtons([
		{
			label: t("copy"),
			primary: true,
			onClick: async () => {
				try {
					await navigator.clipboard.writeText(t);
				} catch {}
				closeOverlay();
			},
		},
		{ label: t("close"), onClick: closeOverlay },
	]);
}

async function finishWithText(text, engineBadge = "") {
	const t = String(text ?? "").trim();
	resetSession();
	if (!t) {
		const ui = openOverlay();
		ui.setStatus("🎤");
		if (engineBadge) ui.setBadge(engineBadge);
		ui.setText(t("empty"), true);
		ui.setButtons([{ label: t("close"), primary: true, onClick: closeOverlay }]);
		setTimeout(closeOverlay, 2500);
		return;
	}
	const ok = (() => {
		try {
			return hostApi()?.compose({ text: t }) ?? false;
		} catch {
			return false;
		}
	})();
	if (ok) {
		closeOverlay();
		return;
	}
	const ui = openOverlay();
	ui.setStatus("🎤");
	if (engineBadge) ui.setBadge(engineBadge);
	ui.setText(t);
	ui.setButtons([
		{
			label: t("copy"),
			primary: true,
			onClick: async () => {
				try {
					await navigator.clipboard.writeText(t);
				} catch {}
				closeOverlay();
			},
		},
		{ label: t("close"), onClick: closeOverlay },
	]);
}

function showError(msg, note = "", actions = []) {
	resetSession();
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(msg, true);
	if (note) ui.setNote(note);
	const btns = Array.isArray(actions) && actions.length ? [...actions] : [];
	btns.push({ label: t("close"), primary: btns.length === 0, onClick: closeOverlay });
	ui.setButtons(btns);
}

function srSupported() {
	try {
		return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
	} catch {
		return false;
	}
}

function serverUsable(cfg) {
	if (!cfg || cfg.serverFallback === false) return false;
	return Boolean(cfg.localReady || cfg.serverReady);
}

export function pickEngineRoute(engine, flags = {}) {
	const e = String(engine || "auto").toLowerCase();
	if (e === "local") return flags.localReady ? "rec" : "install-local";
	if (e === "remote") return flags.serverReady ? "rec" : "remote-missing";
	if (flags.srSupported) return "sr";
	if (!flags.localReady && !flags.serverReady) return "install-generic";
	return flags.serverFallback === false ? "fallback-off" : "rec";
}

function startByEngine(cfg) {
	const route = pickEngineRoute(cfg?.engine, {
		srSupported: srSupported(),
		localReady: Boolean(cfg?.localReady),
		serverReady: Boolean(cfg?.serverReady),
		serverFallback: cfg?.serverFallback !== false,
	});
	const explicit = cfg?.engine === "local" || cfg?.engine === "remote";
	if (route === "sr") {
		startSpeechRecognition(cfg?.lang || "zh-CN", cfg);
		return;
	}
	if (route === "rec") {
		void startRecorderFlow({ explicit });
		return;
	}
	if (route === "install-local") {
		showInstallPrompt(t("localNotInstalled"), cfg);
		return;
	}
	if (route === "remote-missing") {
		showError(t("remoteNotConfigured"), "", [
			{
				label: t("switchEngine"),
				primary: true,
				onClick: () => {
					showEnginePicker(cfg);
				},
			},
		]);
		return;
	}
	if (route === "fallback-off") {
		showError(t("serverFallbackOff"), "", [
			{
				label: t("switchEngine"),
				primary: true,
				onClick: () => {
					showEnginePicker(cfg);
				},
			},
		]);
		return;
	}
	showInstallPrompt(t("noSpeech"), cfg);
}

async function persistEngine(eng) {
	try {
		const r = await fetch(`${apiBase()}/engine`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ engine: eng }),
			credentials: "same-origin",
		});
		if (!r.ok) return false;
		settingsCache = null;
		settingsAt = 0;
		return true;
	} catch {
		return false;
	}
}

function showEnginePicker(cfg) {
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(t("pickEngine"));
	ui.setNote(t("pickEngineNote"));
	const pick = (eng) => () => {
		if (settingsCache) settingsCache = { ...settingsCache, engine: eng };
		const next = { ...(cfg ?? {}), engine: eng };
		void persistEngine(eng).then((ok) => {
			if (!ok) showError(t("engineNotSaved"));
			else startByEngine(next);
		});
	};
	ui.setButtons([
		{ label: t("engAuto"), onClick: pick("auto") },
		{ label: cfg?.localReady ? t("engLocal") : t("engLocalMissing"), onClick: pick("local") },
		{ label: cfg?.serverReady ? t("engRemote") : t("engRemoteMissing"), onClick: pick("remote") },
		{ label: t("close"), onClick: closeOverlay },
	]);
}

function startSpeechRecognition(lang, cfg) {
	const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
	const rec = new Ctor();
	// language code handed to the browser speech API (data)
	rec.lang = lang;
	rec.continuous = true;
	rec.interimResults = true;
	session.recognition = rec;
	session.mode = "sr";
	session.finalText = "";
	session.interim = "";
	session.manualStop = false;
	session.switching = false;
	session.srRestarts = 0;
	const ui = openOverlay();
	session.ui = ui;
	ui.setStatus(`🎤 ${t("listening")}`);
	ui.setBadge(engineBadgeText("sr"));
	const wireButtons = () => {
		const leave = (next) => {
			session.switching = true;
			session.manualStop = true;
			session.finalText = "";
			session.interim = "";
			try {
				rec.abort();
			} catch {}
			next();
		};
		const srBadge = engineBadgeText("sr");
		const btns = [
			{
				label: t("fill"),
				primary: true,
				onClick: () => finishWithText(srTotalText(session.finalText, session.interim), srBadge),
			},
			{ label: t("send"), onClick: () => sendDirectText(srTotalText(session.finalText, session.interim), srBadge) },
			{
				label: t("switchEngine"),
				onClick: () => {
					resetSession();
					showEnginePicker(cfg);
				},
			},
			{
				label: t("cancel"),
				onClick: () => {
					resetSession();
					closeOverlay();
				},
			},
		];
		if (serverUsable(cfg)) {
			btns.splice(1, 0, {
				label: t("useServer"),
				onClick: () => leave(() => void startRecorderFlow()),
			});
		}
		ui.setButtons(btns);
	};
	wireButtons();
	rec.onresult = (ev) => {
		let interim = "";
		for (let i = ev.resultIndex; i < ev.results.length; i++) {
			const r = ev.results[i];
			if (r.isFinal) session.finalText += r[0].transcript;
			else interim += r[0].transcript;
		}
		session.interim = interim;
		ui.setText(srTotalText(session.finalText, interim));
	};
	rec.onerror = (ev) => {
		if (session.mode !== "sr") return;
		if (session.switching) return;
		if (ev?.error === "aborted" && session.manualStop) return;
		const info = srExplain(ev?.error);
		if (info.kind === "denied") {
			showError(info.msg);
			return;
		}
		if (ev?.error === "audio-busy" || ev?.error === "SpeechRecognitionError") {
			showError(t("srBusy"));
			return;
		}
		if (serverUsable(cfg)) {
			session.switching = true;
			try {
				rec.abort();
			} catch {}
			ui.setStatus(`🎤 ${info.msg}`);
			setTimeout(() => {
				if (session.mode === "sr") void startRecorderFlow();
			}, 600);
			return;
		}
		showInstallPrompt(info.msg);
	};
	rec.onend = () => {
		if (session.mode !== "sr") return;
		if (session.switching) {
			if (srTotalText(session.finalText, session.interim))
				void finishWithText(srTotalText(session.finalText, session.interim));
			return;
		}
		if (session.manualStop) {
			void finishWithText(srTotalText(session.finalText, session.interim));
			return;
		}
		if (srTotalText(session.finalText, session.interim)) {
			void finishWithText(srTotalText(session.finalText, session.interim));
			return;
		}
		if (session.srRestarts >= MAX_SR_RESTARTS) {
			if (serverUsable(cfg)) void startRecorderFlow();
			else showInstallPrompt(t("srNoSpeech"));
			return;
		}
		session.srRestarts++;
		try {
			rec.start();
		} catch {
			if (serverUsable(cfg)) void startRecorderFlow();
			else showInstallPrompt(srExplain("").msg);
		}
	};
	try {
		rec.start();
	} catch {
		if (serverUsable(cfg)) void startRecorderFlow();
		else showInstallPrompt(srExplain("").msg);
	}
}

const WORKLET_SRC = `
class ViCap extends AudioWorkletProcessor {
	process(inputs) {
		const ch = inputs && inputs[0];
		if (ch && ch.length) {
			const copy = [];
			for (let i = 0; i < ch.length; i++) copy.push(ch[i].slice(0));
			this.port.postMessage(copy);
		}
		return true;
	}
}
registerProcessor('vi-cap', ViCap);
`;

function capturePcm16k(onAutoStop, onLevel) {
	return new Promise((resolve, reject) => {
		let stream = null;
		let ctx = null;
		let node = null;
		let src = null;
		let workletUrl = null;
		const chunks = [];
		let sampleRate = 16000;
		let settled = false;
		let autoTimer = 0;

		const cleanup = () => {
			try {
				if (typeof onLevel === "function") onLevel(null);
			} catch {}
			try {
				if (autoTimer) clearTimeout(autoTimer);
			} catch {}
			try {
				node?.disconnect();
			} catch {}
			try {
				src?.disconnect();
			} catch {}
			try {
				if (typeof node?.stop === "function") node.stop();
			} catch {}
			try {
				ctx?.close();
			} catch {}
			try {
				stream?.getTracks().forEach((t) => t.stop());
			} catch {}
			if (workletUrl) {
				try {
					URL.revokeObjectURL(workletUrl);
				} catch {}
			}
		};
		const finish = (manual) => {
			if (settled) return null;
			settled = true;
			try {
				if (typeof onLevel === "function") onLevel(null);
			} catch {}
			try {
				if (autoTimer) clearTimeout(autoTimer);
			} catch {}
			const mono = concatMono(chunks);
			const out = resampleTo16k(mono, sampleRate);
			const handle = { cleanup };
			cleanup();
			if (!manual) return { samples: out, handle, auto: true };
			if (!out.length) return { samples: out, handle, empty: true };
			return { samples: out, handle };
		};

		const api = {
			cleanup: () => {
				if (!settled) {
					settled = true;
					cleanup();
				}
			},
		};

		(async () => {
			try {
				if (!navigator.mediaDevices?.getUserMedia) throw new Error("gum-missing");
				stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			} catch {
				reject(new Error(t("micDenied")));
				return;
			}
			try {
				const AC = window.AudioContext || window.webkitAudioContext;
				if (!AC) throw new Error("no-ac");
				try {
					ctx = new AC({ sampleRate: 16000 });
				} catch {
					ctx = new AC();
				}
				sampleRate = ctx.sampleRate || 16000;
			} catch {
				try {
					stream.getTracks().forEach((t) => t.stop());
				} catch {}
				reject(new Error(t("recorderBroken")));
				return;
			}
			src = ctx.createMediaStreamSource(stream);
			let lastLevelAt = 0;
			const push = (frames) => {
				chunks.push(frames);
				if (typeof onLevel === "function") {
					const now = Date.now();
					if (now - lastLevelAt >= 40) {
						lastLevelAt = now;
						const rms = computeAudioRms(frames);
						onLevel(audioLevelFromRms(rms));
					}
				}
			};
			autoTimer = setTimeout(() => {
				const r = finish(true);
				if (r && typeof onAutoStop === "function") {
					try {
						onAutoStop(r.samples);
					} catch {}
				}
			}, MAX_RECORD_MS);

			try {
				workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
				await ctx.audioWorklet.addModule(workletUrl);
				node = new AudioWorkletNode(ctx, "vi-cap");
				node.port.onmessage = (ev) => {
					const arr = ev.data;
					if (Array.isArray(arr) && arr.length) push(downmix(arr.map((c) => Float32Array.from(c))));
				};
				src.connect(node);
				try {
					const zero = ctx.createGain();
					zero.gain.value = 0;
					node.connect(zero);
					zero.connect(ctx.destination);
				} catch {}
			} catch {
				try {
					const sp = ctx.createScriptProcessor(4096, 1, 1);
					node = sp;
					sp.onaudioprocess = (ev) => {
						try {
							push(ev.inputBuffer.getChannelData(0).slice(0));
						} catch {}
					};
					src.connect(sp);
					try {
						const zero = ctx.createGain();
						zero.gain.value = 0;
						sp.connect(zero);
						zero.connect(ctx.destination);
					} catch {}
				} catch {
					cleanup();
					reject(new Error(t("recorderBroken")));
					return;
				}
			}
			resolve({ api, stop: (manual) => finish(manual) });
		})();
	});
}

async function startRecorderFlow(opts = {}) {
	let cfg;
	try {
		cfg = await getSettings();
	} catch {
		showInstallPrompt(t("serverMissing"));
		return;
	}
	const explicitOk = Boolean(opts.explicit) && Boolean(cfg.localReady || cfg.serverReady);
	if (!explicitOk && !serverUsable(cfg)) {
		showInstallPrompt(t("serverMissing"));
		return;
	}
	resetSession();
	session.mode = "rec";
	const activeEng = resolveActiveEngine(cfg, "rec");
	const badge = engineBadgeText(activeEng, { localModel: cfg?.localModel });
	const ui = openOverlay();
	session.ui = ui;
	ui.setStatus(`🎤 ${t("recording")}`);
	ui.setBadge(badge);
	const stopAndTranscribe = (mode) => {
		session.manualStop = true;
		ui.setStatus(`🎤 ${t("uploading")}`);
		ui.setLevel(null);
		ui.setButtons([
			{
				label: t("cancel"),
				onClick: () => {
					resetSession();
					closeOverlay();
				},
			},
		]);
		try {
			const r = session.rec?.stop(true);
			if (r && r.samples) void handleRecorded(r.samples, cfg, false, mode);
		} catch {
			resetSession();
			closeOverlay();
		}
	};
	ui.setButtons([
		{
			label: t("stopAndTranscribe"),
			primary: true,
			onClick: () => stopAndTranscribe("compose"),
		},
		{
			label: t("send"),
			onClick: () => stopAndTranscribe("send"),
		},
		{
			label: t("switchEngine"),
			onClick: () => {
				resetSession();
				showEnginePicker(cfg);
			},
		},
		{
			label: t("cancel"),
			onClick: () => {
				resetSession();
				closeOverlay();
			},
		},
	]);
	try {
		const cap = await capturePcm16k(
			(samples) => {
				if (session.mode === "rec") {
					session.manualStop = true;
					void handleRecorded(samples, cfg, true);
				}
			},
			(level) => {
				if (session.mode === "rec") {
					ui.setLevel(level);
				}
			},
		);
		if (session.mode !== "rec") {
			try {
				cap.api.cleanup();
			} catch {}
			return;
		}
		session.rec = cap;
	} catch (err) {
		showError(err instanceof Error ? err.message : String(err));
	}
}

async function handleRecorded(samples, cfg, timedOut, mode = "compose") {
	const rec = session.rec;
	resetSession();
	const activeEng = resolveActiveEngine(cfg, "rec");
	const initialBadge = engineBadgeText(activeEng, { localModel: cfg?.localModel });
	if (!samples || !samples.length) {
		const ui = openOverlay();
		ui.setStatus("🎤");
		ui.setBadge(initialBadge);
		ui.setText(t("tooShort"), true);
		ui.setButtons([{ label: t("close"), primary: true, onClick: closeOverlay }]);
		setTimeout(closeOverlay, 2500);
		return;
	}
	const ui = openOverlay();
	ui.setStatus(`🎤 ${timedOut ? t("tooLong") : t("uploading")}`);
	ui.setBadge(initialBadge);
	ui.setButtons([
		{
			label: t("cancel"),
			onClick: () => {
				resetSession();
				closeOverlay();
			},
		},
	]);
	try {
		rec?.api?.cleanup?.();
	} catch {}
	let text = "";
	let finalEngine = activeEng;
	try {
		const wav = encodeWavPCM(samples, 16000);
		const blob = new Blob([wav], { type: "audio/wav" });
		const r = await fetch(`${apiBase()}/transcribe?lang=${encodeURIComponent(cfg.lang || "zh-CN")}`, {
			method: "POST",
			headers: { "Content-Type": "audio/wav" },
			body: blob,
			credentials: "same-origin",
		});
		const data = await r.json().catch(() => ({}));
		if (!r.ok) {
			const err = new Error(data?.error || `transcribe ${r.status}`);
			err.status = r.status;
			throw err;
		}
		text = String(data?.text ?? "");
		if (data?.engine) finalEngine = data.engine;
	} catch (err) {
		const status = err?.status || 0;
		if (status === 501) {
			showInstallPrompt(err instanceof Error ? err.message : String(err));
			return;
		}
		showError(err instanceof Error ? err.message : String(err));
		return;
	}
	const finalBadge = engineBadgeText(finalEngine, { localModel: cfg?.localModel });
	if (mode === "send") await sendDirectText(text, finalBadge);
	else await finishWithText(text, finalBadge);
}

function showInstallPrompt(why, cfg = null) {
	resetSession();
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(why || t("serverMissing"));
	ui.setNote(t("installNote"));
	const btns = [{ label: t("installLocal"), primary: true, onClick: () => void runLocalInstall() }];
	if (cfg) {
		btns.push({
			label: t("switchEngine"),
			onClick: () => {
				showEnginePicker(cfg);
			},
		});
	}
	btns.push({ label: t("close"), onClick: closeOverlay });
	ui.setButtons(btns);
}

async function fetchLocalStatus() {
	const r = await fetch(`${apiBase()}/local-status`, { credentials: "same-origin" });
	if (!r.ok) throw new Error(`local-status ${r.status}`);
	return r.json();
}

async function runLocalInstall() {
	const ui = openOverlay();
	ui.setStatus(`🎤 ${t("installing", { p: "…" })}`);
	ui.setNote(t("installNote"));
	ui.setButtons([{ label: t("close"), onClick: closeOverlay }]);
	try {
		const r = await fetch(`${apiBase()}/local-install`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			credentials: "same-origin",
		});
		const data = await r.json().catch(() => ({}));
		if (!r.ok && r.status !== 202) throw new Error(data?.error || `local-install ${r.status}`);
	} catch (err) {
		ui.setStatus("🎤");
		ui.setText(t("installFailedDetail", { error: err instanceof Error ? err.message : String(err) }), true);
		ui.setButtons([
			{ label: t("retry"), primary: true, onClick: () => void runLocalInstall() },
			{ label: t("close"), onClick: closeOverlay },
		]);
		return;
	}
	const currentOverlay = overlay;
	const timer = setInterval(async () => {
		if (!overlay || overlay !== currentOverlay) {
			clearInterval(timer);
			return;
		}
		let st;
		try {
			st = await fetchLocalStatus();
		} catch {
			return;
		}
		if (st.installing) {
			const pct = typeof st.progress === "number" ? `${st.progress}%` : "";
			const phase = st.phase ? t("installPhase", { phase: st.phase }) : "";
			ui.setStatus(`🎤 ${t("installing", { p: `${pct} ${phase}`.trim() })}`);
			return;
		}
		clearInterval(timer);
		if (!overlay || overlay !== currentOverlay) return;
		if (st.error) {
			ui.setStatus("🎤");
			ui.setText(t("installFailedDetail", { error: st.error }), true);
			ui.setButtons([
				{ label: t("retry"), primary: true, onClick: () => void runLocalInstall() },
				{ label: t("close"), onClick: closeOverlay },
			]);
			return;
		}
		if (st.ready) {
			settingsAt = 0;
			ui.setStatus(`🎤 ${t("installDone")}`);
			ui.setText("");
			ui.setNote("");
			setTimeout(() => {
				if (overlay === currentOverlay && session.mode === "idle") void startRecorderFlow();
			}, 600);
			return;
		}
		ui.setStatus("🎤");
		ui.setText(t("installFailed"), true);
		ui.setButtons([{ label: t("close"), primary: true, onClick: closeOverlay }]);
	}, 1000);
}

function isSecure() {
	try {
		if (typeof window.isSecureContext === "boolean") return window.isSecureContext;
		const proto = window.location?.protocol;
		return proto === "https:" || proto === "wss:" || window.location?.hostname === "localhost";
	} catch {
		return true;
	}
}

async function toggle() {
	if (session.mode === "sr") {
		session.manualStop = true;
		try {
			session.recognition?.stop();
		} catch {
			void finishWithText(session.finalText);
		}
		return;
	}
	if (session.mode === "rec") {
		session.manualStop = true;
		try {
			const cap = session.rec;
			const r = cap?.stop(true);
			let cfg = { lang: "zh-CN" };
			try {
				cfg = await getSettings();
			} catch {}
			if (r && r.samples) void handleRecorded(r.samples, cfg, false);
		} catch {
			resetSession();
			closeOverlay();
		}
		return;
	}
	if (!isSecure()) {
		showError(t("insecure"));
		return;
	}
	let cfg = { lang: "zh-CN", engine: "auto", serverFallback: true, serverReady: false, localReady: false };
	try {
		cfg = await getSettings();
	} catch {}
	startByEngine(cfg);
}

const CAMERA_ACTION = "voice-input:camera";
const CAMERA_MAX_DIM = 1568;
const CAMERA_MAX_BYTES = 2 * 1024 * 1024;
let camFacing = "environment";
let camPanel = null;
let camStream = null;

function cameraCapable() {
	try {
		return Boolean(window.isSecureContext) && Boolean(navigator.mediaDevices?.getUserMedia);
	} catch {
		return false;
	}
}

function stopCamStream() {
	if (!camStream) return;
	for (const t of camStream.getTracks()) {
		try {
			t.stop();
		} catch {}
	}
	camStream = null;
}

let camScrollHandler = null;
let camResizeObserver = null;

function cleanupCamPositioner() {
	if (camScrollHandler) {
		window.removeEventListener("resize", camScrollHandler);
		window.removeEventListener("scroll", camScrollHandler, true);
		camScrollHandler = null;
	}
	if (camResizeObserver) {
		camResizeObserver.disconnect();
		camResizeObserver = null;
	}
}

function closeCameraPanel() {
	cleanupCamPositioner();
	stopCamStream();
	if (camPanel) {
		camPanel.remove();
		camPanel = null;
	}
}

function frameToJpegBase64(source, srcW, srcH) {
	if (!srcW || !srcH) throw new Error(t("camNoFrame"));
	const canvas = document.createElement("canvas");
	let scale = Math.min(1, CAMERA_MAX_DIM / Math.max(srcW, srcH));
	for (let attempt = 0; attempt < 4; attempt++) {
		canvas.width = Math.max(1, Math.round(srcW * scale));
		canvas.height = Math.max(1, Math.round(srcH * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("canvas 2d unavailable");
		ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
		const base64 = canvas.toDataURL("image/jpeg", attempt === 0 ? 0.92 : 0.85).replace(/^data:[^;]*;base64,/, "");
		if (base64.length * 0.75 <= CAMERA_MAX_BYTES) return base64;
		scale *= 0.7;
	}
	throw new Error(t("camTooBig"));
}

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(t("camDecodeFailed")));
		img.src = src;
	});
}

function attachPhoto(base64) {
	const host = hostApi();
	if (!base64) return false;
	const name = `photo-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jpg`;
	return Boolean(
		host?.compose?.({
			attachments: [
				{
					path: "",
					name,
					mode: "inline",
					imageData: base64,
					mimeType: "image/jpeg",
					key: `capture:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
				},
			],
		}),
	);
}

async function attachPickedFile(file) {
	const url = URL.createObjectURL(file);
	try {
		const img = await loadImage(url);
		return attachPhoto(frameToJpegBase64(img, img.naturalWidth, img.naturalHeight));
	} finally {
		URL.revokeObjectURL(url);
	}
}

function pickViaSystemCamera() {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*";
	input.setAttribute("capture", "environment");
	input.style.display = "none";
	document.body.append(input);
	input.addEventListener("change", () => {
		const f = input.files?.[0];
		input.remove();
		if (f) void attachPickedFile(f);
	});
	input.click();
}

function openCameraPanel() {
	closeCameraPanel();
	const root = document.createElement("div");
	root.className = "vc-panel";
	root.style.setProperty("--accent-contrast", getAccentContrastColor());
	root.style.visibility = "hidden";
	root.innerHTML = `
<style>
	.vc-panel {
		position: fixed;
		z-index: 9999; width: min(520px, 94vw);
		background: var(--bg-elev, #16161d); color: inherit;
		border: 1px solid var(--border, #333); border-radius: 12px;
		padding: 10px 12px 12px; font-size: 13px;
		box-shadow: 0 8px 32px rgba(0,0,0,.45);
	}
	.vc-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
	.vc-title { font-weight: 600; }
	.vc-x { margin-left: auto; border: 0; background: transparent; color: inherit;
		font: inherit; cursor: pointer; opacity: .6; padding: 2px 6px; }
	.vc-x:hover { opacity: 1; }
	.vc-video { width: 100%; max-height: 52vh; border-radius: 8px; background: #000; display: block; }
	.vc-hint { opacity: .7; font-size: 12px; line-height: 1.6; margin: 8px 0 2px; }
	.vc-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; flex-wrap: wrap; }
	.vc-btns button { border: 1px solid var(--border, #333); border-radius: 6px;
		background: transparent; color: inherit; font: inherit; padding: 5px 14px; cursor: pointer; }
	.vc-btns .primary {
		background: var(--accent, #7c5cff);
		border-color: transparent;
		color: var(--accent-contrast, #fff);
		font-weight: 500;
	}
	.vc-btns .primary:hover:not(:disabled) { filter: brightness(0.92); }
	.vc-btns button:disabled { opacity: .45; cursor: default; }
	.vc-hide { display: none !important; }
</style>
<div class="vc-head"><span>📷</span><span class="vc-title"></span><button class="vc-x" type="button">✕</button></div>
<video class="vc-video" playsinline autoplay muted></video>
<div class="vc-hint"></div>
<div class="vc-btns">
	<button class="vc-file primary vc-hide" type="button"></button>
	<button class="vc-switch" type="button"></button>
	<button class="vc-shot primary" type="button"></button>
</div>`;
	document.body.append(root);
	camPanel = root;

	const updateCamPos = () => {
		if (camPanel) positionOverlayToAnchor(camPanel, CAMERA_ACTION);
	};
	updateCamPos();
	root.style.visibility = "";

	camScrollHandler = updateCamPos;
	window.addEventListener("resize", updateCamPos, { passive: true });
	window.addEventListener("scroll", updateCamPos, { capture: true, passive: true });

	if (typeof ResizeObserver !== "undefined") {
		camResizeObserver = new ResizeObserver(() => {
			updateCamPos();
		});
		camResizeObserver.observe(root);
	}

	const video = root.querySelector(".vc-video");
	const hint = root.querySelector(".vc-hint");
	const closeBtn = root.querySelector(".vc-x");
	const fileBtn = root.querySelector(".vc-file");
	const switchBtn = root.querySelector(".vc-switch");
	const shotBtn = root.querySelector(".vc-shot");
	const setHint = (t) => {
		hint.textContent = t;
		requestAnimationFrame(updateCamPos);
	};
	const show = (el, on) => {
		el.classList.toggle("vc-hide", !on);
		requestAnimationFrame(updateCamPos);
	};

	root.querySelector(".vc-title").textContent = t("camTitle");
	closeBtn.title = t("close");
	shotBtn.textContent = t("camShoot");
	switchBtn.textContent = t("camSwitch");
	fileBtn.textContent = t("camFile");

	closeBtn.addEventListener("click", closeCameraPanel);
	fileBtn.addEventListener("click", () => pickViaSystemCamera());

	const fallback = (msg) => {
		stopCamStream();
		show(video, false);
		show(shotBtn, false);
		show(switchBtn, false);
		show(fileBtn, true);
		setHint(msg);
	};

	const startLive = async () => {
		if (!cameraCapable()) {
			fallback(t("camInsecure"));
			return;
		}
		stopCamStream();
		show(video, false);
		show(fileBtn, false);
		setHint(t("camStarting"));
		try {
			camStream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: camFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
				audio: false,
			});
		} catch (err) {
			fallback(err?.name === "NotAllowedError" ? t("camDenied") : t("camUnavailable"));
			return;
		}
		if (!camPanel) {
			stopCamStream();
			return;
		}
		video.srcObject = camStream;
		try {
			await video.play();
		} catch {}
		show(video, true);
		show(shotBtn, true);
		const cams = await navigator.mediaDevices.enumerateDevices().catch(() => []);
		show(switchBtn, cams.filter((d) => d.kind === "videoinput").length > 1);
		setHint(t("camHint"));
	};

	switchBtn.addEventListener("click", () => {
		camFacing = camFacing === "environment" ? "user" : "environment";
		void startLive();
	});

	shotBtn.addEventListener("click", () => {
		try {
			setHint(
				attachPhoto(frameToJpegBase64(video, video.videoWidth, video.videoHeight))
					? t("camShot")
					: t("camComposeFailed"),
			);
		} catch (err) {
			setHint(err instanceof Error ? err.message : String(err));
		}
	});

	void startLive();
}

function register() {
	try {
		hostApi()?.onUiAction?.(ACTION, () => {
			void toggle();
		});
		hostApi()?.onUiAction?.(CAMERA_ACTION, () => {
			openCameraPanel();
		});
	} catch {}
}

register();

export default {
	mount() {
		register();
		return () => {
			closeCameraPanel();
		};
	},
};
