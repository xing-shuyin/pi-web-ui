import { hostApi, apiBase as getSharedApiBase } from "@pi-web-ui/plugin-sdk/client";

const ACTION = "voice-input:toggle";
const MAX_RECORD_MS = 5 * 60 * 1000;
const MAX_SR_RESTARTS = 2;

function apiBase() {
	return getSharedApiBase("voice-input");
}

const isZh = (() => {
	try {
		return (navigator.language || "zh-CN").toLowerCase().startsWith("zh");
	} catch {
		return true;
	}
})();

const T = {
	listening: isZh ? "正在聆听…（再点 🎤 结束）" : "Listening… (click 🎤 again to finish)",
	recording: isZh ? "正在录音…（再点 🎤 结束并转写）" : "Recording… (click 🎤 again to transcribe)",
	uploading: isZh ? "转写中…" : "Transcribing…",
	send: isZh ? "直接发送" : "Send",
	fill: isZh ? "填入输入框" : "Fill composer",
	stopAndTranscribe: isZh ? "停止并转写" : "Stop & transcribe",
	sendFailed: isZh
		? "直接发送没接通，已填入输入框，请手动发送"
		: "Direct send unavailable — filled into the composer, please send manually",
	cancel: isZh ? "取消" : "Cancel",
	close: isZh ? "关闭" : "Close",
	useServer: isZh ? "改用服务端录音" : "Use server recording",
	installLocal: isZh ? "一键安装本地 Whisper" : "Install local Whisper",
	retry: isZh ? "重试" : "Retry",
	installing: (p) => (isZh ? `正在安装本地 Whisper… ${p}` : `Installing local Whisper… ${p}`),
	installDone: isZh ? "安装完成，开始录音吧" : "Installed, start speaking",
	installFailed: isZh ? "安装失败" : "Install failed",
	noSpeech: isZh ? "浏览器语音识别不可用" : "Browser recognition unavailable",
	serverMissing: isZh
		? "服务端转写还没得用：本地 Whisper 没装，远端接口也没配"
		: "No server transcription: local Whisper not installed, no remote endpoint configured",
	empty: isZh ? "没听清，请再说一次" : "Didn't catch that, please try again",
	composeFailed: isZh
		? "输入框还没准备好，已复制到剪贴板，请粘贴发送"
		: "Composer not ready, copied to clipboard instead",
	copied: isZh ? "已复制" : "Copied",
	camTitle: isZh ? "拍照" : "Take photo",
	camShoot: isZh ? "拍照并放入输入框" : "Capture into composer",
	camSwitch: isZh ? "切换摄像头" : "Switch camera",
	camFile: isZh ? "用系统相机 / 选图片" : "Use system camera / pick a file",
	camStarting: isZh ? "正在打开摄像头…" : "Opening camera…",
	camHint: isZh
		? "对准要拍的东西，点「拍照并放入输入框」；可以连拍多张，拍完补一句话再发。"
		: "Aim at what you want to capture, then hit “Capture into composer”. You can take several shots; add a sentence and send.",
	camShot: isZh ? "已放入输入框附件，可继续拍" : "Added to the composer — keep shooting if needed",
	camComposeFailed: isZh
		? "输入框还没准备好（页面刚打开？），稍后再拍一张"
		: "Composer not ready (page still loading?) — try again in a moment",
	camDenied: isZh
		? "摄像头被拒绝：请点浏览器地址栏左侧的 🔒 图标，把本站摄像头设为“允许”，再重试；也可以直接用系统相机。"
		: "Camera permission denied: click the 🔒 icon in the address bar, allow camera for this site, then retry — or use the system camera.",
	camUnavailable: isZh
		? "打不开摄像头（设备没有摄像头，或被其它程序占用）。可以直接用系统相机拍。"
		: "Camera could not be opened (no camera on this device, or it is busy). You can use the system camera instead.",
	camInsecure: isZh
		? "当前页面不是安全上下文（http://局域网IP 打开的吧？）：浏览器直接禁用了摄像头。请改用 http://localhost:8787 或 http://127.0.0.1:8787 打开本站；手机等设备可以直接用系统相机。"
		: "This page is not a secure context (opened via http://LAN-IP?): the browser disables the camera. Reopen via http://localhost:8787 or http://127.0.0.1:8787 — on phones you can use the system camera instead.",
	insecure: isZh
		? "当前页面不是安全上下文（http://局域网IP 打开的吧？）：浏览器直接禁用了语音识别和麦克风。请改用 http://localhost:8787 或 http://127.0.0.1:8787 打开本站，再点 🎤。"
		: "This page is not a secure context (opened via http://LAN-IP?): the browser disables speech recognition and mic. Reopen via http://localhost:8787 or http://127.0.0.1:8787 and try again.",
	micDenied: isZh
		? "麦克风被拒绝：请点浏览器地址栏左侧的 🔒/🎤 图标，把本站麦克风设为“允许”，然后重试。"
		: "Microphone denied: click the lock/mic icon left of the address bar, allow the mic for this site, then retry.",
	srNetwork: isZh
		? "浏览器语音服务连不上（Edge/Chrome 识别要联网，代理·VPN·企业策略都可能拦）：已为你切到服务端录音；也可以检查网络后重试。"
		: "Browser speech service unreachable (Edge/Chrome recognition needs internet; proxy/VPN/enterprise policy may block it). Switched to server recording; or check network and retry.",
	srNoSpeech: isZh
		? "浏览器没听到声音就断了（静音超时/麦克风没声）：靠近麦克风再说一次，或改用服务端录音。"
		: "Browser stopped hearing audio (silence timeout / no mic signal). Speak closer, or use server recording.",
	srBusy: isZh
		? "浏览器语音识别正忙（可能别的标签页占着），请稍等几秒再点 🎤。"
		: "Browser recognition busy (maybe another tab holds it). Wait a few seconds and retry.",
	tooShort: isZh ? "录音太短了，请说完一句话再结束。" : "Recording too short, please finish a sentence.",
	tooLong: isZh ? "录音超过 5 分钟已自动结束，正在转写…" : "Over 5 minutes, auto-finished. Transcribing…",
	recorderBroken: isZh
		? "浏览器录不了音（AudioContext/Gum 不可用，多半还是非安全上下文，见上）：请用 localhost 打开本站。"
		: "This browser cannot record (AudioContext/getUserMedia unavailable, likely insecure context). Reopen via localhost.",
	installNote: isZh
		? "本地 Whisper：免费、无需 key、录音不出本机。首次安装要下载约 150–300MB（模型）+ 运行时，关掉浮层会在后台继续装。"
		: "Local Whisper: free, no key, audio never leaves this machine. First install downloads ~150–300MB (model) + runtime; closing this panel keeps installing in background.",
	switchEngine: isZh ? "切换识别方式" : "Switch engine",
	pickEngine: isZh ? "用哪种识别方式？" : "Which recognition engine?",
	pickEngineNote: isZh
		? "选完会存回插件设置，下次点 🎤 直接用这一档。本地 Whisper 还没装的话，选它会直接带你装。"
		: "Your choice is saved back to the plugin settings and used by the 🎤 button next time. If local Whisper isn't installed yet, picking it walks you through the install.",
	engAuto: isZh ? "浏览器联网识别（免费实时）" : "Browser recognition (free, live)",
	engLocal: isZh ? "本地 Whisper（离线，不出本机）" : "Local Whisper (offline, on-device)",
	engRemote: isZh ? "远端转写接口" : "Remote endpoint",
	engLocalMissing: isZh ? "本地 Whisper（未安装，点此安装）" : "Local Whisper (not installed — install)",
	engRemoteMissing: isZh ? "远端接口（未配置）" : "Remote endpoint (not configured)",
	engineNotSaved: isZh
		? "切换没存上（服务端没确认），这次没开始：请到插件设置里直接把「转写引擎」改成你要的那一档"
		: "Couldn't save the switch (the server didn't confirm), so nothing started: change “Transcription engine” in the plugin settings instead",
	localNotInstalled: isZh
		? "本地 Whisper 还没装。装一次就能一直离线识别，录音不出本机、不需要 key。"
		: "Local Whisper isn't installed yet. Install it once for offline dictation — audio never leaves this machine, no key needed.",
	remoteNotConfigured: isZh
		? "还没配远端转写接口：在插件设置里填「转写接口基址」与密钥，或改成用本地 Whisper。"
		: "No remote endpoint configured: fill in the transcription base URL and key in the plugin settings, or switch to local Whisper.",
	serverFallbackOff: isZh
		? "「服务端转写降级」关着，服务端录音这条路被封了：去插件设置里打开它，或改用浏览器识别。"
		: "“Server transcription fallback” is off, so server recording is disabled: turn it on in the plugin settings, or use browser recognition.",
};

export function srExplain(code) {
	const c = String(code || "");
	if (c === "not-allowed" || c === "service-not-allowed") return { msg: T.micDenied, kind: "denied" };
	if (c === "network") return { msg: T.srNetwork, kind: "network" };
	if (c === "no-speech") return { msg: T.srNoSpeech, kind: "nospeech" };
	if (c === "audio-capture") return { msg: T.srNoSpeech, kind: "nospeech" };
	if (c === "aborted") return { msg: T.empty, kind: "aborted" };
	if (c === "language-not-supported") return { msg: T.noSpeech, kind: "unsupported" };
	return { msg: `${T.noSpeech}（${c || "unknown"}）`, kind: "other" };
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
	const zh = options.isZh ?? isZh;
	const id = String(engineId || "").toLowerCase();
	if (id === "sr") {
		return zh ? "🌐 浏览器识别" : "🌐 Browser speech";
	}
	if (id === "remote") {
		return zh ? "☁️ 远端接口" : "☁️ Remote endpoint";
	}
	const model = options.localModel || "base";
	return zh ? `🧠 本地 Whisper(${model})` : `🧠 Local Whisper (${model})`;
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
		ui.setText(T.empty, true);
		ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
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
		ui.setNote(T.sendFailed);
		ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
		setTimeout(closeOverlay, 3000);
		return;
	}
	const ui = openOverlay();
	ui.setStatus("🎤");
	if (engineBadge) ui.setBadge(engineBadge);
	ui.setText(t);
	ui.setButtons([
		{
			label: isZh ? "复制" : "Copy",
			primary: true,
			onClick: async () => {
				try {
					await navigator.clipboard.writeText(t);
				} catch {}
				closeOverlay();
			},
		},
		{ label: T.close, onClick: closeOverlay },
	]);
}

async function finishWithText(text, engineBadge = "") {
	const t = String(text ?? "").trim();
	resetSession();
	if (!t) {
		const ui = openOverlay();
		ui.setStatus("🎤");
		if (engineBadge) ui.setBadge(engineBadge);
		ui.setText(T.empty, true);
		ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
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
			label: isZh ? "复制" : "Copy",
			primary: true,
			onClick: async () => {
				try {
					await navigator.clipboard.writeText(t);
				} catch {}
				closeOverlay();
			},
		},
		{ label: T.close, onClick: closeOverlay },
	]);
}

function showError(msg, note = "", actions = []) {
	resetSession();
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(msg, true);
	if (note) ui.setNote(note);
	const btns = Array.isArray(actions) && actions.length ? [...actions] : [];
	btns.push({ label: T.close, primary: btns.length === 0, onClick: closeOverlay });
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
		showInstallPrompt(T.localNotInstalled, cfg);
		return;
	}
	if (route === "remote-missing") {
		showError(T.remoteNotConfigured, "", [
			{
				label: T.switchEngine,
				primary: true,
				onClick: () => {
					showEnginePicker(cfg);
				},
			},
		]);
		return;
	}
	if (route === "fallback-off") {
		showError(T.serverFallbackOff, "", [
			{
				label: T.switchEngine,
				primary: true,
				onClick: () => {
					showEnginePicker(cfg);
				},
			},
		]);
		return;
	}
	showInstallPrompt(T.noSpeech, cfg);
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
	ui.setText(T.pickEngine);
	ui.setNote(T.pickEngineNote);
	const pick = (eng) => () => {
		if (settingsCache) settingsCache = { ...settingsCache, engine: eng };
		const next = { ...(cfg ?? {}), engine: eng };
		void persistEngine(eng).then((ok) => {
			if (!ok) showError(T.engineNotSaved);
			else startByEngine(next);
		});
	};
	ui.setButtons([
		{ label: T.engAuto, onClick: pick("auto") },
		{ label: cfg?.localReady ? T.engLocal : T.engLocalMissing, onClick: pick("local") },
		{ label: cfg?.serverReady ? T.engRemote : T.engRemoteMissing, onClick: pick("remote") },
		{ label: T.close, onClick: closeOverlay },
	]);
}

function startSpeechRecognition(lang, cfg) {
	const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
	const rec = new Ctor();
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
	ui.setStatus(`🎤 ${T.listening}`);
	ui.setBadge(engineBadgeText("sr", { isZh }));
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
		const srBadge = engineBadgeText("sr", { isZh });
		const btns = [
			{
				label: T.fill,
				primary: true,
				onClick: () => finishWithText(srTotalText(session.finalText, session.interim), srBadge),
			},
			{ label: T.send, onClick: () => sendDirectText(srTotalText(session.finalText, session.interim), srBadge) },
			{
				label: T.switchEngine,
				onClick: () => {
					resetSession();
					showEnginePicker(cfg);
				},
			},
			{
				label: T.cancel,
				onClick: () => {
					resetSession();
					closeOverlay();
				},
			},
		];
		if (serverUsable(cfg)) {
			btns.splice(1, 0, {
				label: T.useServer,
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
			showError(T.srBusy);
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
			else showInstallPrompt(T.srNoSpeech);
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
				reject(new Error(T.micDenied));
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
				reject(new Error(T.recorderBroken));
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
					reject(new Error(T.recorderBroken));
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
		showInstallPrompt(T.serverMissing);
		return;
	}
	const explicitOk = Boolean(opts.explicit) && Boolean(cfg.localReady || cfg.serverReady);
	if (!explicitOk && !serverUsable(cfg)) {
		showInstallPrompt(T.serverMissing);
		return;
	}
	resetSession();
	session.mode = "rec";
	const activeEng = resolveActiveEngine(cfg, "rec");
	const badge = engineBadgeText(activeEng, { isZh, localModel: cfg?.localModel });
	const ui = openOverlay();
	session.ui = ui;
	ui.setStatus(`🎤 ${T.recording}`);
	ui.setBadge(badge);
	const stopAndTranscribe = (mode) => {
		session.manualStop = true;
		ui.setStatus(`🎤 ${T.uploading}`);
		ui.setLevel(null);
		ui.setButtons([
			{
				label: T.cancel,
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
			label: T.stopAndTranscribe,
			primary: true,
			onClick: () => stopAndTranscribe("compose"),
		},
		{
			label: T.send,
			onClick: () => stopAndTranscribe("send"),
		},
		{
			label: T.switchEngine,
			onClick: () => {
				resetSession();
				showEnginePicker(cfg);
			},
		},
		{
			label: T.cancel,
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
	const initialBadge = engineBadgeText(activeEng, { isZh, localModel: cfg?.localModel });
	if (!samples || !samples.length) {
		const ui = openOverlay();
		ui.setStatus("🎤");
		ui.setBadge(initialBadge);
		ui.setText(T.tooShort, true);
		ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
		setTimeout(closeOverlay, 2500);
		return;
	}
	const ui = openOverlay();
	ui.setStatus(`🎤 ${timedOut ? T.tooLong : T.uploading}`);
	ui.setBadge(initialBadge);
	ui.setButtons([
		{
			label: T.cancel,
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
	const finalBadge = engineBadgeText(finalEngine, { isZh, localModel: cfg?.localModel });
	if (mode === "send") await sendDirectText(text, finalBadge);
	else await finishWithText(text, finalBadge);
}

function showInstallPrompt(why, cfg = null) {
	resetSession();
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(why || T.serverMissing);
	ui.setNote(T.installNote);
	const btns = [{ label: T.installLocal, primary: true, onClick: () => void runLocalInstall() }];
	if (cfg) {
		btns.push({
			label: T.switchEngine,
			onClick: () => {
				showEnginePicker(cfg);
			},
		});
	}
	btns.push({ label: T.close, onClick: closeOverlay });
	ui.setButtons(btns);
}

async function fetchLocalStatus() {
	const r = await fetch(`${apiBase()}/local-status`, { credentials: "same-origin" });
	if (!r.ok) throw new Error(`local-status ${r.status}`);
	return r.json();
}

async function runLocalInstall() {
	const ui = openOverlay();
	ui.setStatus(`🎤 ${T.installing("…")}`);
	ui.setNote(T.installNote);
	ui.setButtons([{ label: T.close, onClick: closeOverlay }]);
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
		ui.setText(`${T.installFailed}：${err instanceof Error ? err.message : String(err)}`, true);
		ui.setButtons([
			{ label: T.retry, primary: true, onClick: () => void runLocalInstall() },
			{ label: T.close, onClick: closeOverlay },
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
			const phase = st.phase ? `（${st.phase}）` : "";
			ui.setStatus(`🎤 ${T.installing(`${pct} ${phase}`.trim())}`);
			return;
		}
		clearInterval(timer);
		if (!overlay || overlay !== currentOverlay) return;
		if (st.error) {
			ui.setStatus("🎤");
			ui.setText(`${T.installFailed}：${st.error}`, true);
			ui.setButtons([
				{ label: T.retry, primary: true, onClick: () => void runLocalInstall() },
				{ label: T.close, onClick: closeOverlay },
			]);
			return;
		}
		if (st.ready) {
			settingsAt = 0;
			ui.setStatus(`🎤 ${T.installDone}`);
			ui.setText("");
			ui.setNote("");
			setTimeout(() => {
				if (overlay === currentOverlay && session.mode === "idle") void startRecorderFlow();
			}, 600);
			return;
		}
		ui.setStatus("🎤");
		ui.setText(T.installFailed, true);
		ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
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
		showError(T.insecure);
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
	if (!srcW || !srcH) throw new Error(isZh ? "取不到画面尺寸，请稍后再拍" : "No frame size yet, try again");
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
	throw new Error(isZh ? "照片压不进 2MB，请离远一点再拍" : "Photo stays above 2MB — step back and retry");
}

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(isZh ? "图片解码失败" : "Image decode failed"));
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

	root.querySelector(".vc-title").textContent = T.camTitle;
	closeBtn.title = T.close;
	shotBtn.textContent = T.camShoot;
	switchBtn.textContent = T.camSwitch;
	fileBtn.textContent = T.camFile;

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
			fallback(T.camInsecure);
			return;
		}
		stopCamStream();
		show(video, false);
		show(fileBtn, false);
		setHint(T.camStarting);
		try {
			camStream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: camFacing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
				audio: false,
			});
		} catch (err) {
			fallback(err?.name === "NotAllowedError" ? T.camDenied : T.camUnavailable);
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
		setHint(T.camHint);
	};

	switchBtn.addEventListener("click", () => {
		camFacing = camFacing === "environment" ? "user" : "environment";
		void startLive();
	});

	shotBtn.addEventListener("click", () => {
		try {
			setHint(
				attachPhoto(frameToJpegBase64(video, video.videoWidth, video.videoHeight)) ? T.camShot : T.camComposeFailed,
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
