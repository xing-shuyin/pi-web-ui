/**
 * voice-input 客户端 —— 输入框麦克风按钮的全部逻辑（裸 ESM，无依赖）。
 *
 * 链路：
 *   manifest `ui.composer` 声明 🎤 按钮（宿主渲染，见 ChatInput）→ 用户点击 →
 *   宿主 `triggerPluginUiAction` 按需 import 本文件（view:false，平时不加载）→
 *   顶层代码注册 `onUiAction("voice-input:toggle")` → toggle() 开始/结束录音 →
 *   「填入输入框」经 `window.__piWebUiHost.compose({ text })` 并入输入框草稿
 *   （用户再编辑发送）；「直接发送」经 `startChat({ prompt, newChat:false })`
 *   发给当前对话，不需要编辑。
 *
 * 识别策略（`engine` 设置，点 🎤 时直接分流，不必等联网失败）：
 *   auto   先用浏览器原生识别（Chrome/Edge，免费实时出字），出错/不支持再降级；
 *   local  直接走服务端本地 Whisper（录音不出本机）；还没装就直接弹一键安装；
 *   remote 直接走服务端远端接口。
 *   三档都能在录音浮层里随时切（切完写回设置，下次 🎤 直接用这一档）。
 *   服务端录音：AudioWorklet 现场采 16k 单声道 WAV →
 *      POST /plugins-api/voice-input/transcribe → 本地 Whisper 或远端接口转写；
 *   服务端也没得用 → 浮层里「一键安装本地 Whisper」（后台下载，进度轮询，
 *      装完自动开始录音），或去设置里配远端转写接口。
 *
 * Edge 排障经验（用户实测“完全不能识别”多半是这三个之一）：
 *   - 页面走 http://<局域网IP> 打开 = 非安全上下文：语音识别和麦克风同时被
 *     浏览器掐掉。请用 http://localhost:8787 / http://127.0.0.1:8787 打开。
 *   - Edge 语音服务要联网（network 错误）：代理/VPN/企业策略可能拦。
 *   - 麦克风权限被拒（not-allowed）：地址栏左侧把麦克风设为允许。
 * 以上都映射成中文提示，不再只有一个“没听清”。
 *
 * 与宿主只有两条窄通道：`window.__piWebUiHost.compose/onUiAction`（动作）与
 * 自家服务端的 HTTP 路由（配置/转写/安装）。拿不到 React 状态，也不需要。
 */

const ACTION = "voice-input:toggle";
/** 最长录音 5 分钟（16k 单声道 WAV ≈ 9.6MB，服务端 15MB 上限内）。 */
const MAX_RECORD_MS = 5 * 60 * 1000;
/** 浏览器静默自动断句后悄悄续听，最多续 2 次，防无限空转。 */
const MAX_SR_RESTARTS = 2;

/** 应用根前缀 + 本插件服务端基址（import.meta.url 推导，子路径反代也对）。 */
function apiBase() {
	try {
		const u = new URL(import.meta.url);
		const i = u.pathname.indexOf("/plugins/");
		const prefix = i >= 0 ? u.pathname.slice(0, i) : "";
		return `${u.origin}${prefix}/plugins-api/voice-input`;
	} catch {
		return "/plugins-api/voice-input";
	}
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

/** 浏览器原生识别的错误码 → 中文人话。纯展示映射，方便单测/排障。 */
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

/**
 * 单声道 Float32（目标采样率）→ 16-bit PCM WAV（Uint8Array）。
 * 服务端 decodeWav16k 的镜像；导出给单测做端到端往返。
 */
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

/** 录音分片首尾拼接（worklet 每 128 帧推一块，这里是时间轴拼接，不是声道平均）。 */
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

/** 多声道平均成单声道。 */
function downmix(channels) {
	if (!channels.length) return new Float32Array(0);
	if (channels.length === 1) return channels[0].slice();
	const len = Math.max(...channels.map((c) => c.length));
	const out = new Float32Array(len);
	for (const c of channels) for (let i = 0; i < c.length; i++) out[i] += c[i] / channels.length;
	return out;
}

/** 线性重采样到 16k（与服务端 decodeWav16k 对齐，减小上传体积）。 */
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

/** 插件服务端公开配置（GET /settings，不含密钥），60s 缓存。 */
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

function hostApi() {
	try {
		return window.__piWebUiHost ?? null;
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* 浮层（录音状态 + 中间结果 + 完成/取消，纯 DOM）                      */
/* ------------------------------------------------------------------ */

let overlay = null;
let overlayTimer = 0;

function closeOverlay() {
	if (overlay) {
		overlay.remove();
		overlay = null;
	}
}

/** 建浮层。返回 { setText, setState, onDone, onCancel } 由调用方接线。 */
function openOverlay() {
	closeOverlay();
	// 上一个浮层的计时器要停掉：它盯的是全局 `overlay`，换一个浮层它并不会自杀，
	// 于是每切一次识别方式就泄一个 500ms 的 interval（一直写进已脱离文档的节点）。
	if (overlayTimer) {
		clearInterval(overlayTimer);
		overlayTimer = 0;
	}
	const root = document.createElement("div");
	root.className = "vi-overlay";
	root.innerHTML = `
<style>
	.vi-overlay {
		position: fixed; left: 50%; bottom: 132px; transform: translateX(-50%);
		z-index: 9999; min-width: 300px; max-width: min(560px, 92vw);
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
	.vi-btns .primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
	.vi-err { color: #e5484d; }
	.vi-note { opacity: .65; font-size: 12px; margin: 6px 0 2px; line-height: 1.6; }
</style>
<div class="vi-row"><span class="vi-dot"></span><span class="vi-status"></span><span class="vi-time"></span></div>
<div class="vi-text"></div>
<div class="vi-note" style="display:none"></div>
<div class="vi-btns"></div>`;
	document.body.append(root);
	const statusEl = root.querySelector(".vi-status");
	const textEl = root.querySelector(".vi-text");
	const noteEl = root.querySelector(".vi-note");
	const timeEl = root.querySelector(".vi-time");
	const btnsEl = root.querySelector(".vi-btns");
	overlay = root;
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
		},
		setText(s, isErr = false) {
			textEl.textContent = s;
			textEl.classList.toggle("vi-err", isErr);
		},
		setNote(s) {
			if (!s) {
				noteEl.style.display = "none";
				noteEl.textContent = "";
			} else {
				noteEl.style.display = "";
				noteEl.textContent = s;
			}
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
		},
	};
}

/* ------------------------------------------------------------------ */
/* 会话状态机：idle | sr(浏览器识别) | rec(服务端录音)                  */
/* ------------------------------------------------------------------ */

/** 浏览器识别的最终文本 + 中间结果拼成要发送的全文。纯函数，单测覆盖。 */
export function srTotalText(finalText, interim) {
	return `${String(finalText ?? "")}${String(interim ?? "")}`.trim();
}

const session = {
	mode: "idle", // idle | sr | rec
	recognition: null,
	finalText: "",
	interim: "",
	manualStop: false,
	// 切服务端途中：吞掉 abort 激起的 onend/onerror，避免“字进了输入框还弹录音”。
	switching: false,
	srRestarts: 0,
	ui: null,
	rec: null, // { stop(manual:boolean), cleanup() } 服务端录音句柄
};

function resetSession() {
	try {
		session.recognition?.abort();
	} catch {
		/* ignore */
	}
	try {
		session.rec?.cleanup();
	} catch {
		/* ignore */
	}
	session.mode = "idle";
	session.recognition = null;
	session.rec = null;
	session.finalText = "";
	session.interim = "";
	session.manualStop = false;
	session.switching = false;
	session.srRestarts = 0;
}

/** 文本进输入框草稿（用户再编辑/手动发送）。返回是否接通。 */
function tryComposeText(t) {
	try {
		return hostApi()?.compose({ text: t }) ?? false;
	} catch {
		return false;
	}
}

/**
 * 文本直接发给当前对话（不进草稿、不新建对话、不需要编辑）。
 * startChat 默认 newChat=true 会另起对话，这里必须显式 newChat:false
 * 留在当前对话里发出去。
 */
function trySendDirect(t) {
	try {
		const fn = hostApi()?.startChat;
		if (typeof fn !== "function") return false;
		return fn.call(hostApi(), { prompt: t, newChat: false }) ?? false;
	} catch {
		return false;
	}
}

/**
 * 文本收尾·直接发送：接通就关浮层；没接通（断线/旧宿主没有 startChat）
 * 就回落到填入输入框，并用一行 note 告诉用户手动点发送；两条路都走不通
 * 才给复制按钮（不丢字）。
 */
async function sendDirectText(text) {
	const t = String(text ?? "").trim();
	resetSession();
	if (!t) {
		const ui = openOverlay();
		ui.setStatus("🎤");
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
		ui.setText(t);
		ui.setNote(T.sendFailed);
		ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
		setTimeout(closeOverlay, 3000);
		return;
	}
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(t);
	ui.setButtons([
		{
			label: isZh ? "复制" : "Copy",
			primary: true,
			onClick: async () => {
				try {
					await navigator.clipboard.writeText(t);
				} catch {
					/* ignore */
				}
				closeOverlay();
			},
		},
		{ label: T.close, onClick: closeOverlay },
	]);
}

/** 文本收尾：进输入框草稿；进不去就给复制按钮（不丢字）。 */
async function finishWithText(text) {
	const t = String(text ?? "").trim();
	resetSession();
	if (!t) {
		const ui = openOverlay();
		ui.setStatus("🎤");
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
	ui.setText(t);
	ui.setButtons([
		{
			label: isZh ? "复制" : "Copy",
			primary: true,
			onClick: async () => {
				try {
					await navigator.clipboard.writeText(t);
				} catch {
					/* ignore */
				}
				closeOverlay();
			},
		},
		{ label: T.close, onClick: closeOverlay },
	]);
}

function showError(msg, note = "") {
	resetSession();
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(msg, true);
	if (note) ui.setNote(note);
	ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
}

/* ---------------- 浏览器原生识别（Web Speech API） ---------------- */

function srSupported() {
	try {
		return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
	} catch {
		return false;
	}
}

/** 服务端录音可用的前提：降级开关开 + 本地/远端至少一边就绪。 */
function serverUsable(cfg) {
	if (!cfg || cfg.serverFallback === false) return false;
	return Boolean(cfg.localReady || cfg.serverReady);
}

/**
 * 引擎设置 + 当前就绪情况 → 起手动作。纯函数（不碰 DOM/fetch），单测覆盖。
 *
 * 返回：
 *   "sr"              浏览器原生识别（Web Speech）
 *   "rec"             服务端录音（本地 Whisper / 远端接口转写）
 *   "install-local"   选了 local 但没装 → 直接弹一键安装
 *   "remote-missing"  选了 remote 但没配接口 → 提示去设置
 *   "install-generic" auto 且浏览器没识别能力、服务端也没得用
 *   "fallback-off"    auto 且服务端就绪但「降级」开关关着
 *
 * 关键点（issue #383）：`local` / `remote` 是**主动选择**，点 🎤 就直接走它，
 * 不再「先测浏览器能不能联网、失败后才降级」—— 那是旧 toggle 的毛病，
 * 于是每次都得先干等几秒报错。
 */
export function pickEngineRoute(engine, flags = {}) {
	const e = String(engine || "auto").toLowerCase();
	if (e === "local") return flags.localReady ? "rec" : "install-local";
	if (e === "remote") return flags.serverReady ? "rec" : "remote-missing";
	if (flags.srSupported) return "sr";
	if (!flags.localReady && !flags.serverReady) return "install-generic";
	return flags.serverFallback === false ? "fallback-off" : "rec";
}

/** 按引擎分发起始识别。toggle() 与切换面板共用这一份，别写两套。 */
function startByEngine(cfg) {
	const route = pickEngineRoute(cfg?.engine, {
		srSupported: srSupported(),
		localReady: Boolean(cfg?.localReady),
		serverReady: Boolean(cfg?.serverReady),
		serverFallback: cfg?.serverFallback !== false,
	});
	// 显式选了 local/remote 时，「服务端转写降级」开关不该拦住用户点名要的那条路
	//（降级开关是给 auto 兜底用的）。
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
		showInstallPrompt(T.localNotInstalled);
		return;
	}
	if (route === "remote-missing") {
		showError(T.remoteNotConfigured);
		return;
	}
	if (route === "fallback-off") {
		showError(T.serverFallbackOff);
		return;
	}
	showInstallPrompt(T.noSpeech);
}

/** 把引擎选择写回服务端（= 声明式设置里的 `engine`）。失败不抛：本次仍照用。 */
async function persistEngine(eng) {
	try {
		const r = await fetch(`${apiBase()}/engine`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ engine: eng }),
			credentials: "same-origin",
		});
		if (!r.ok) return false;
		// 配置缓存作废：下面 startByEngine 要拿到新的 localReady/serverReady。
		settingsCache = null;
		settingsAt = 0;
		return true;
	} catch {
		return false;
	}
}

/** 「用哪种识别方式」面板：常驻在录音浮层里，不必等联网失败才有机会换（issue #383）。 */
function showEnginePicker(cfg) {
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(T.pickEngine);
	ui.setNote(T.pickEngineNote);
	const pick = (eng) => () => {
		// 先本地改缓存：不等网络回包就能开始录音（写回失败也只是不持久）。
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
	// 必须清掉上一轮的 switching：从识别切到「切换面板」再切回来时，
	// 旗子残留会让新识别的 onend 误以为是切途中（不续听也不收尾，识别静默死掉）。
	session.switching = false;
	session.srRestarts = 0;
	const ui = openOverlay();
	session.ui = ui;
	ui.setStatus(`🎤 ${T.listening}`);
	const wireButtons = () => {
		/** 离开当前识别去做别的（切服务端 / 开切换面板）：先立旗再 abort，
		 *  否则 abort 激起的 onend 会把浏览器半截文字收尾。
		 *  半截文字直接丢掉（切过去就是要重说），onend 见空会让路。 */
		const leave = (next) => {
			session.switching = true;
			session.manualStop = true;
			session.finalText = "";
			session.interim = "";
			try {
				rec.abort();
			} catch {
				/* ignore */
			}
			next();
		};
		const btns = [
			{ label: T.fill, primary: true, onClick: () => finishWithText(srTotalText(session.finalText, session.interim)) },
			{ label: T.send, onClick: () => sendDirectText(srTotalText(session.finalText, session.interim)) },
			// 常驻的切换入口：不必等浏览器联网失败才有机会换成本地识别（issue #383）。
			// 走 resetSession 而不是 leave()：它先把 mode 置 idle 再收工，abort 激起的
			// onend 醒来时看到 idle 就直接返回，浮层关掉后也不会留下“僵尸识别态”。
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
		// 切换/手动结束途中 abort 激起的 aborted：吞掉，否则会多排一次切服务端。
		if (session.switching) return;
		if (ev?.error === "aborted" && session.manualStop) return;
		const info = srExplain(ev?.error);
		// 权限/服务拒绝：重试也没用，直接报清楚。
		if (info.kind === "denied") {
			showError(info.msg);
			return;
		}
		// 识别中途被抢占：等几秒让用户自己再点。
		if (ev?.error === "audio-busy" || ev?.error === "SpeechRecognitionError") {
			showError(T.srBusy);
			return;
		}
		// 其余错误：能走服务端就悄悄切过去，否则把原因摆出来。
		if (serverUsable(cfg)) {
			// 先立旗：abort 激起的 onend 不许复活识别（有字则收尾、无字让路，见 onend）。
			session.switching = true;
			try {
				rec.abort();
			} catch {
				/* ignore */
			}
			ui.setStatus(`🎤 ${info.msg}`);
			setTimeout(() => {
				if (session.mode === "sr") void startRecorderFlow();
			}, 600);
			return;
		}
		showInstallPrompt(info.msg);
	};
	rec.onend = () => {
		// 用户点的完成/取消/切换：finishWithText/showInstallPrompt/startRecorderFlow
		// 里已经 reset，不能复活。
		if (session.mode !== "sr") return;
		// 切服务端途中 abort 激起的 onend：有字就收尾（收尾把 mode 置 idle，
		// 挂起的延迟切换自动取消，成功优先）；没字才让路给服务端录音。
		if (session.switching) {
			if (srTotalText(session.finalText, session.interim))
				void finishWithText(srTotalText(session.finalText, session.interim));
			return;
		}
		if (session.manualStop) {
			void finishWithText(srTotalText(session.finalText, session.interim));
			return;
		}
		// 有字就收尾（浏览器按静音断的句）；没字才续听，且最多续 N 次。
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

/* ---------------- 服务端录音：WAV → 转写 ---------------- */

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

/**
 * 采一段 16k 单声道 PCM。worklet 优先，失败回退 ScriptProcessor。
 * resolve 出 { samples: Float32Array }；中途出错 reject（人话错误）。
 */
function capturePcm16k(onAutoStop) {
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
				if (autoTimer) clearTimeout(autoTimer);
			} catch {
				/* ignore */
			}
			try {
				node?.disconnect();
			} catch {
				/* ignore */
			}
			try {
				src?.disconnect();
			} catch {
				/* ignore */
			}
			try {
				if (typeof node?.stop === "function") node.stop();
			} catch {
				/* ignore */
			}
			try {
				ctx?.close();
			} catch {
				/* ignore */
			}
			try {
				stream?.getTracks().forEach((t) => t.stop());
			} catch {
				/* ignore */
			}
			if (workletUrl) {
				try {
					URL.revokeObjectURL(workletUrl);
				} catch {
					/* ignore */
				}
			}
		};
		const finish = (manual) => {
			if (settled) return null;
			settled = true;
			try {
				if (autoTimer) clearTimeout(autoTimer);
			} catch {
				/* ignore */
			}
			// 注意：chunks 是按时间切的分片，必须拼接；downmix 是声道平均，
			// 误用会把整段录音压成 128 个采样的糊（之前转写永远为空就是这个原因）。
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
				} catch {
					/* ignore */
				}
				reject(new Error(T.recorderBroken));
				return;
			}
			src = ctx.createMediaStreamSource(stream);
			const push = (frames) => {
				chunks.push(frames);
			};
			// 5 分钟自动收尾：走回调直接进转写（await 那头早已 resolve，不能再 resolve）。
			autoTimer = setTimeout(() => {
				const r = finish(true);
				if (r && typeof onAutoStop === "function") {
					try {
						onAutoStop(r.samples);
					} catch {
						/* ignore */
					}
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
				// worklet 不接 destination 不出声，但有些浏览器要求连上才跑：
				// 经零增益节点接地，既跑起来又不出声。
				try {
					const zero = ctx.createGain();
					zero.gain.value = 0;
					node.connect(zero);
					zero.connect(ctx.destination);
				} catch {
					/* ignore */
				}
			} catch {
				// 回退：ScriptProcessor（deprecated 但全浏览器可用）。
				try {
					const sp = ctx.createScriptProcessor(4096, 1, 1);
					node = sp;
					sp.onaudioprocess = (ev) => {
						try {
							push(ev.inputBuffer.getChannelData(0).slice(0));
						} catch {
							/* ignore */
						}
					};
					src.connect(sp);
					try {
						const zero = ctx.createGain();
						zero.gain.value = 0;
						sp.connect(zero);
						zero.connect(ctx.destination);
					} catch {
						/* ignore */
					}
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

/**
 * 服务端录音 → 转写。opts.explicit = 用户显式选了 local/remote 引擎，
 * 此时「服务端转写降级」开关不拦（它是给 auto 兜底用的）。
 */
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
	const ui = openOverlay();
	session.ui = ui;
	ui.setStatus(`🎤 ${T.recording}`);
	const stopAndTranscribe = (mode) => {
		session.manualStop = true;
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
			label: T.fill,
			primary: true,
			onClick: () => stopAndTranscribe("compose"),
		},
		{
			label: T.send,
			onClick: () => stopAndTranscribe("send"),
		},
		{
			// 常驻的切换入口：录到一半也能改主意换引擎（resetSession 顺带关麦）。
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
		const cap = await capturePcm16k((samples) => {
			// 5 分钟自动收尾：stop() 已 settled（再调返回 null），直接进转写。
			if (session.mode === "rec") {
				session.manualStop = true;
				void handleRecorded(samples, cfg, true);
			}
		});
		if (session.mode !== "rec") {
			// 用户在授权弹窗那几秒里点了取消：直接收摊。
			try {
				cap.api.cleanup();
			} catch {
				/* ignore */
			}
			return;
		}
		session.rec = cap;
	} catch (err) {
		showError(err instanceof Error ? err.message : String(err));
	}
}

/**
 * 录音收尾 → 转写 → 按 mode 收尾：compose=填入输入框（用户再编辑发送），
 * send=直接发给当前对话（不需要编辑）。mode 默认 compose（自动收尾/旧调用）。
 */
async function handleRecorded(samples, cfg, timedOut, mode = "compose") {
	const rec = session.rec;
	resetSession();
	if (!samples || !samples.length) {
		const ui = openOverlay();
		ui.setStatus("🎤");
		ui.setText(T.tooShort, true);
		ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
		setTimeout(closeOverlay, 2500);
		return;
	}
	const ui = openOverlay();
	ui.setStatus(`🎤 ${timedOut ? T.tooLong : T.uploading}`);
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
	} catch {
		/* ignore */
	}
	let text = "";
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
	} catch (err) {
		const status = err?.status || 0;
		// 501（两边都没得用）→ 直接给安装入口，别只抛一句话。
		if (status === 501) {
			showInstallPrompt(err instanceof Error ? err.message : String(err));
			return;
		}
		showError(err instanceof Error ? err.message : String(err));
		return;
	}
	if (mode === "send") await sendDirectText(text);
	else await finishWithText(text);
}

/* ---------------- 一键安装本地 Whisper ---------------- */

function showInstallPrompt(why) {
	resetSession();
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(why || T.serverMissing);
	ui.setNote(T.installNote);
	ui.setButtons([
		{ label: T.installLocal, primary: true, onClick: () => void runLocalInstall() },
		{ label: T.close, onClick: closeOverlay },
	]);
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
	// 安装中途关浮层 = 后台继续装，不取消服务端任务。
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
	// 轮询进度（overlay 关了就停轮询，服务端照装）。
	const timer = setInterval(async () => {
		if (!overlay) {
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
		if (!overlay) return;
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
			settingsAt = 0; // 配置缓存作废，重读 localReady
			ui.setStatus(`🎤 ${T.installDone}`);
			ui.setText("");
			ui.setNote("");
			// 装完直接开录，一气呵成。
			setTimeout(() => {
				if (overlay) void startRecorderFlow();
			}, 600);
			return;
		}
		ui.setStatus("🎤");
		ui.setText(T.installFailed, true);
		ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
	}, 1000);
}

/* ---------------- 入口：🎤 按钮 ---------------- */

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
	// 录音中再点 = 结束并收尾。
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
			} catch {
				/* 用默认语言转写 */
			}
			// stop() 返回 null = 自动收尾已接管（回调里进了转写），这里什么都不做。
			if (r && r.samples) void handleRecorded(r.samples, cfg, false);
		} catch {
			resetSession();
			closeOverlay();
		}
		return;
	}
	// 非安全上下文：语音识别+麦克风全被浏览器掐掉，先说清楚（Edge 走局域网 IP 常踩）。
	if (!isSecure()) {
		showError(T.insecure);
		return;
	}
	// 空闲 → 开始：先读配置（语言 + 引擎 + 降级开关 + 服务端是否就绪）。
	let cfg = { lang: "zh-CN", engine: "auto", serverFallback: true, serverReady: false, localReady: false };
	try {
		cfg = await getSettings();
	} catch {
		/* 读不到就按默认引擎跑，降级时再报错 */
	}
	// 引擎分流在 startByEngine 一处（与浮层里的切换面板共用，issue #383）。
	startByEngine(cfg);
}

/* ------------------------------------------------------------------ */
/* 拍照（📷）：摄像头现场取景 → 照片作为附件进输入框                    */
/*                                                                     */
/* 为什么走宿主的 compose：照片最终要和用户补的那句话一起发出去，而   */
/* 「待发附件」是宿主 App 的 state（composer-bridge 的附件 sink）。    */
/* 插件只产出 JPEG，剩下的交给宿主既有链路（与粘贴图片同一条）。       */
/*                                                                     */
/* 为什么要两档：getUserMedia 在非安全上下文 / 无摄像头 / 权限被拒时  */
/* 全是不可用，而「手机系统相机」这条件在这些情况下照样能拍 ——       */
/* 所以失败不让用户干瞪眼，直接给一条路（与 🎤 浮层的排障风格一致）。 */
/* ------------------------------------------------------------------ */

const CAMERA_ACTION = "voice-input:camera";
/** 最长边与上限：与宿主粘贴图片同一口径（1568 ≈ 1.5K vision 裁切），别把原图塞进上下文。 */
const CAMERA_MAX_DIM = 1568;
const CAMERA_MAX_BYTES = 2 * 1024 * 1024;
/** 前置/后置偏好：本会话记住就够（换设备、换场景比「一劳永逸的偏好」更常见）。 */
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
		} catch {
			/* ignore */
		}
	}
	camStream = null;
}

/** 关面板一律顺带停流：摄像头指示灯亮着而面板没了是最糟的收尾。 */
function closeCameraPanel() {
	stopCamStream();
	if (camPanel) {
		camPanel.remove();
		camPanel = null;
	}
}

/**
 * 把一帧画到 canvas 再编码 JPEG：先按最长边压到 1568，仍超 2MB 就逐档降尺寸。
 * 2MB 是服务端粘贴图片的硬上限（agent-service 的 MAX_PASTED_IMAGE_BYTES），超了会被拒。
 */
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

/** 照片 → 输入框待发附件。imageData 走宿主既有的粘贴图片链路（服务端当图像内容发给模型）。 */
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
					// key 让宿主判重有身份可用；同一秒连拍多张也不会互相顶掉。
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

/** 回退档：系统相机（手机直接调起）或文件选择（桌面退化成选图）。 */
function pickViaSystemCamera() {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*";
	// capture 让手机直接开相机；桌面浏览器忽略它，退化成选图。不需要任何权限。
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
	root.innerHTML = `
<style>
	.vc-panel {
		position: fixed; left: 50%; bottom: 132px; transform: translateX(-50%);
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
	.vc-btns .primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
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

	const video = root.querySelector(".vc-video");
	const hint = root.querySelector(".vc-hint");
	const closeBtn = root.querySelector(".vc-x");
	const fileBtn = root.querySelector(".vc-file");
	const switchBtn = root.querySelector(".vc-switch");
	const shotBtn = root.querySelector(".vc-shot");
	const setHint = (t) => {
		hint.textContent = t;
	};
	const show = (el, on) => el.classList.toggle("vc-hide", !on);

	root.querySelector(".vc-title").textContent = T.camTitle;
	closeBtn.title = T.close;
	shotBtn.textContent = T.camShoot;
	switchBtn.textContent = T.camSwitch;
	fileBtn.textContent = T.camFile;

	closeBtn.addEventListener("click", closeCameraPanel);
	fileBtn.addEventListener("click", () => pickViaSystemCamera());

	/** 摄像头这条走不通时的收场：留住面板当提示牌，只留「系统相机」一条出路。 */
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
		} catch {
			/* 自动播放被拦：首帧可能不出，但快门依旧能取帧 */
		}
		show(video, true);
		show(shotBtn, true);
		// 只有一个摄像头时切换按钮没意义（多数桌面机）；enumerateDevices 要权限后才给全量。
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
	} catch {
		/* 宿主太旧：按钮点了没反应总比崩好（manifest 里 apiVersion 会先拦住旧版） */
	}
}

register();

/**
 * loadOne 要求 default.mount 是函数（否则记 failed → 首次点击只注册不执行）。
 * view:false 插件没有可见视图，这里给一个空挂载；真正的注册在顶层 register()。
 * mount 被调用时（隐藏 pane）再注册一次——Set 去重，幂等。
 */
export default {
	mount() {
		register();
		return () => {
			// 面板随插件反激活收尾；摄像头不能留着亮灯。
			closeCameraPanel();
		};
	},
};
