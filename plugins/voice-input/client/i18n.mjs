import { createPluginI18n } from "@pi-web-ui/plugin-sdk/client";

/**
 * 语音 / 拍照输入的插件自有词典。
 * 语言解析 / 回退（当前 → 基语言 → en → key）与单遍插值由 SDK 的 createPluginI18n 统一实现，
 * 插件这边只维护 zh / en 两份文案，不再自己写 detectLang + 字符串拼接。
 *
 * 不放进词典的东西（属于数据 / 契约，不随界面语言变）：
 * - 识别语言码（zh-CN / en-US / ja-JP…）：同时是 SpeechRecognition.lang 与 /transcribe?lang= 的取值；
 * - 本地模型 id（base / tiny / small → Xenova/whisper-*)：服务端白名单里的模型标识；
 * - 引擎 id（sr / local / remote / auto）：设置与 /engine 路由的持久化取值；
 * - serverOwned* 之外的进度文案与服务端错误：由服务端返回，插件只负责展示。
 */
export const DICT = {
	zh: {
		// 语音浮层通用
		listening: "正在聆听…（再点 🎤 结束）",
		recording: "正在录音…（再点 🎤 结束并转写）",
		uploading: "转写中…",
		send: "直接发送",
		fill: "填入输入框",
		stopAndTranscribe: "停止并转写",
		sendFailed: "直接发送没接通，已填入输入框，请手动发送",
		cancel: "取消",
		close: "关闭",
		copy: "复制",
		useServer: "改用服务端录音",
		retry: "重试",
		switchEngine: "切换识别方式",
		empty: "没听清，请再说一次",

		// 本地 Whisper 安装
		installLocal: "一键安装本地 Whisper",
		installing: "正在安装本地 Whisper… {p}",
		installPhase: "（{phase}）",
		installDone: "安装完成，开始录音吧",
		installFailed: "安装失败",
		installFailedDetail: "安装失败：{error}",
		installNote:
			"本地 Whisper：免费、无需 key、录音不出本机。首次安装要下载约 150–300MB（模型）+ 运行时，关掉浮层会在后台继续装。",

		// 引擎选择
		pickEngine: "用哪种识别方式？",
		pickEngineNote: "选完会存回插件设置，下次点 🎤 直接用这一档。本地 Whisper 还没装的话，选它会直接带你装。",
		engAuto: "浏览器联网识别（免费实时）",
		engLocal: "本地 Whisper（离线，不出本机）",
		engRemote: "远端转写接口",
		engLocalMissing: "本地 Whisper（未安装，点此安装）",
		engRemoteMissing: "远端接口（未配置）",
		engineNotSaved: "切换没存上（服务端没确认），这次没开始：请到插件设置里直接把「转写引擎」改成你要的那一档",

		// 不可用时的出路
		noSpeech: "浏览器语音识别不可用",
		srUnknown: "浏览器语音识别不可用（{code}）",
		serverMissing: "服务端转写还没得用：本地 Whisper 没装，远端接口也没配",
		localNotInstalled: "本地 Whisper 还没装。装一次就能一直离线识别，录音不出本机、不需要 key。",
		remoteNotConfigured: "还没配远端转写接口：在插件设置里填「转写接口基址」与密钥，或改成用本地 Whisper。",
		serverFallbackOff: "「服务端转写降级」关着，服务端录音这条路被封了：去插件设置里打开它，或改用浏览器识别。",

		// 引擎徽标
		badgeSr: "🌐 浏览器识别",
		badgeRemote: "☁️ 远端接口",
		badgeLocal: "🧠 本地 Whisper({model})",

		// 浏览器识别错误
		micDenied: "麦克风被拒绝：请点浏览器地址栏左侧的 🔒/🎤 图标，把本站麦克风设为“允许”，然后重试。",
		srNetwork:
			"浏览器语音服务连不上（Edge/Chrome 识别要联网，代理·VPN·企业策略都可能拦）：已为你切到服务端录音；也可以检查网络后重试。",
		srNoSpeech: "浏览器没听到声音就断了（静音超时/麦克风没声）：靠近麦克风再说一次，或改用服务端录音。",
		srBusy: "浏览器语音识别正忙（可能别的标签页占着），请稍等几秒再点 🎤。",
		tooShort: "录音太短了，请说完一句话再结束。",
		tooLong: "录音超过 5 分钟已自动结束，正在转写…",
		recorderBroken: "浏览器录不了音（AudioContext/Gum 不可用，多半还是非安全上下文，见上）：请用 localhost 打开本站。",
		insecure:
			"当前页面不是安全上下文（http://局域网IP 打开的吧？）：浏览器直接禁用了语音识别和麦克风。请改用 http://localhost:8787 或 http://127.0.0.1:8787 打开本站，再点 🎤。",

		// 拍照浮层
		camTitle: "拍照",
		camShoot: "拍照并放入输入框",
		camSwitch: "切换摄像头",
		camFile: "用系统相机 / 选图片",
		camStarting: "正在打开摄像头…",
		camHint: "对准要拍的东西，点「拍照并放入输入框」；可以连拍多张，拍完补一句话再发。",
		camShot: "已放入输入框附件，可继续拍",
		camComposeFailed: "输入框还没准备好（页面刚打开？），稍后再拍一张",
		camDenied: "摄像头被拒绝：请点浏览器地址栏左侧的 🔒 图标，把本站摄像头设为“允许”，再重试；也可以直接用系统相机。",
		camUnavailable: "打不开摄像头（设备没有摄像头，或被其它程序占用）。可以直接用系统相机拍。",
		camInsecure:
			"当前页面不是安全上下文（http://局域网IP 打开的吧？）：浏览器直接禁用了摄像头。请改用 http://localhost:8787 或 http://127.0.0.1:8787 打开本站；手机等设备可以直接用系统相机。",
		camNoFrame: "取不到画面尺寸，请稍后再拍",
		camTooBig: "照片压不进 2MB，请离远一点再拍",
		camDecodeFailed: "图片解码失败",
	},
	"zh-TW": {
		// 语音浮层通用
		listening: "正在聆聽…（再點 🎤 結束）",
		recording: "正在錄音…（再點 🎤 結束並轉寫）",
		uploading: "轉寫中…",
		send: "直接傳送",
		fill: "填入輸入框",
		stopAndTranscribe: "停止並轉寫",
		sendFailed: "直接傳送沒接通，已填入輸入框，請手動傳送",
		cancel: "取消",
		close: "關閉",
		copy: "複製",
		useServer: "改用服務端錄音",
		retry: "重試",
		switchEngine: "切換識別方式",
		empty: "沒聽清，請再說一次",

		// 本地 Whisper 安装
		installLocal: "一鍵安裝本地 Whisper",
		installing: "正在安裝本地 Whisper… {p}",
		installPhase: "（{phase}）",
		installDone: "安裝完成，開始錄音吧",
		installFailed: "安裝失敗",
		installFailedDetail: "安裝失敗：{error}",
		installNote:
			"本地 Whisper：免費、無需 key、錄音不出本機。首次安裝要下載約 150–300MB（模型）+ 執行時，關掉浮層會在後臺繼續裝。",

		// 引擎选择
		pickEngine: "用哪種識別方式？",
		pickEngineNote: "選完會存回外掛設定，下次點 🎤 直接用這一檔。本地 Whisper 還沒裝的話，選它會直接帶你裝。",
		engAuto: "瀏覽器聯網識別（免費即時）",
		engLocal: "本地 Whisper（離線，不出本機）",
		engRemote: "遠端轉寫介面",
		engLocalMissing: "本地 Whisper（未安裝，點此安裝）",
		engRemoteMissing: "遠端介面（未配置）",
		engineNotSaved: "切換沒存上（服務端沒確認），這次沒開始：請到外掛設定裡直接把「轉寫引擎」改成你要的那一檔",

		// 不可用时的出路
		noSpeech: "瀏覽器語音識別不可用",
		srUnknown: "瀏覽器語音識別不可用（{code}）",
		serverMissing: "服務端轉寫還沒得用：本地 Whisper 沒裝，遠端介面也沒配",
		localNotInstalled: "本地 Whisper 還沒裝。裝一次就能一直離線識別，錄音不出本機、不需要 key。",
		remoteNotConfigured: "還沒配遠端轉寫介面：在外掛設定裡填「轉寫介面基址」與金鑰，或改成用本地 Whisper。",
		serverFallbackOff: "「服務端轉寫降級」關著，服務端錄音這條路被封了：去外掛設定裡開啟它，或改用瀏覽器識別。",

		// 引擎徽标
		badgeSr: "🌐 瀏覽器識別",
		badgeRemote: "☁️ 遠端介面",
		badgeLocal: "🧠 本地 Whisper({model})",

		// 浏览器识别错误
		micDenied: "麥克風被拒絕：請點瀏覽器位址列左側的 🔒/🎤 圖示，把本站麥克風設為“允許”，然後重試。",
		srNetwork:
			"瀏覽器語音服務連不上（Edge/Chrome 識別要聯網，代理·VPN·企業策略都可能攔）：已為你切到服務端錄音；也可以檢查網路後重試。",
		srNoSpeech: "瀏覽器沒聽到聲音就斷了（靜音超時/麥克風沒聲）：靠近麥克風再說一次，或改用服務端錄音。",
		srBusy: "瀏覽器語音識別正忙（可能別的標籤頁佔著），請稍等幾秒再點 🎤。",
		tooShort: "錄音太短了，請說完一句話再結束。",
		tooLong: "錄音超過 5 分鐘已自動結束，正在轉寫…",
		recorderBroken: "瀏覽器錄不了音（AudioContext/Gum 不可用，多半還是非安全上下文，見上）：請用 localhost 開啟本站。",
		insecure:
			"當前頁面不是安全上下文（http://區域網IP 開啟的吧？）：瀏覽器直接停用了語音識別和麥克風。請改用 http://localhost:8787 或 http://127.0.0.1:8787 開啟本站，再點 🎤。",

		// 拍照浮层
		camTitle: "拍照",
		camShoot: "拍照並放入輸入框",
		camSwitch: "切換攝像頭",
		camFile: "用系統相機 / 選圖片",
		camStarting: "正在開啟攝像頭…",
		camHint: "對準要拍的東西，點「拍照並放入輸入框」；可以連拍多張，拍完補一句話再發。",
		camShot: "已放入輸入框附件，可繼續拍",
		camComposeFailed: "輸入框還沒準備好（頁面剛開啟？），稍後再拍一張",
		camDenied: "攝像頭被拒絕：請點瀏覽器位址列左側的 🔒 圖示，把本站攝像頭設為“允許”，再重試；也可以直接用系統相機。",
		camUnavailable: "打不開攝像頭（裝置沒有攝像頭，或被其它程式佔用）。可以直接用系統相機拍。",
		camInsecure:
			"當前頁面不是安全上下文（http://區域網IP 開啟的吧？）：瀏覽器直接停用了攝像頭。請改用 http://localhost:8787 或 http://127.0.0.1:8787 開啟本站；手機等裝置可以直接用系統相機。",
		camNoFrame: "取不到畫面尺寸，請稍後再拍",
		camTooBig: "照片壓不進 2MB，請離遠一點再拍",
		camDecodeFailed: "圖片解碼失敗",
	},
	en: {
		// Voice overlay
		listening: "Listening… (click 🎤 again to finish)",
		recording: "Recording… (click 🎤 again to transcribe)",
		uploading: "Transcribing…",
		send: "Send",
		fill: "Fill composer",
		stopAndTranscribe: "Stop & transcribe",
		sendFailed: "Direct send unavailable — filled into the composer, please send manually",
		cancel: "Cancel",
		close: "Close",
		copy: "Copy",
		useServer: "Use server recording",
		retry: "Retry",
		switchEngine: "Switch engine",
		empty: "Didn't catch that, please try again",

		// Local Whisper install
		installLocal: "Install local Whisper",
		installing: "Installing local Whisper… {p}",
		installPhase: "({phase})",
		installDone: "Installed, start speaking",
		installFailed: "Install failed",
		installFailedDetail: "Install failed: {error}",
		installNote:
			"Local Whisper: free, no key, audio never leaves this machine. First install downloads ~150–300MB (model) + runtime; closing this panel keeps installing in background.",

		// Engine picker
		pickEngine: "Which recognition engine?",
		pickEngineNote:
			"Your choice is saved back to the plugin settings and used by the 🎤 button next time. If local Whisper isn't installed yet, picking it walks you through the install.",
		engAuto: "Browser recognition (free, live)",
		engLocal: "Local Whisper (offline, on-device)",
		engRemote: "Remote endpoint",
		engLocalMissing: "Local Whisper (not installed — install)",
		engRemoteMissing: "Remote endpoint (not configured)",
		engineNotSaved:
			"Couldn't save the switch (the server didn't confirm), so nothing started: change “Transcription engine” in the plugin settings instead",

		// Fallbacks
		noSpeech: "Browser recognition unavailable",
		srUnknown: "Browser recognition unavailable ({code})",
		serverMissing: "No server transcription: local Whisper not installed, no remote endpoint configured",
		localNotInstalled:
			"Local Whisper isn't installed yet. Install it once for offline dictation — audio never leaves this machine, no key needed.",
		remoteNotConfigured:
			"No remote endpoint configured: fill in the transcription base URL and key in the plugin settings, or switch to local Whisper.",
		serverFallbackOff:
			"“Server transcription fallback” is off, so server recording is disabled: turn it on in the plugin settings, or use browser recognition.",

		// Engine badge
		badgeSr: "🌐 Browser speech",
		badgeRemote: "☁️ Remote endpoint",
		badgeLocal: "🧠 Local Whisper ({model})",

		// Browser recognition errors
		micDenied:
			"Microphone denied: click the lock/mic icon left of the address bar, allow the mic for this site, then retry.",
		srNetwork:
			"Browser speech service unreachable (Edge/Chrome recognition needs internet; proxy/VPN/enterprise policy may block it). Switched to server recording; or check network and retry.",
		srNoSpeech:
			"Browser stopped hearing audio (silence timeout / no mic signal). Speak closer, or use server recording.",
		srBusy: "Browser recognition busy (maybe another tab holds it). Wait a few seconds and retry.",
		tooShort: "Recording too short, please finish a sentence.",
		tooLong: "Over 5 minutes, auto-finished. Transcribing…",
		recorderBroken:
			"This browser cannot record (AudioContext/getUserMedia unavailable, likely insecure context). Reopen via localhost.",
		insecure:
			"This page is not a secure context (opened via http://LAN-IP?): the browser disables speech recognition and mic. Reopen via http://localhost:8787 or http://127.0.0.1:8787 and try again.",

		// Camera panel
		camTitle: "Take photo",
		camShoot: "Capture into composer",
		camSwitch: "Switch camera",
		camFile: "Use system camera / pick a file",
		camStarting: "Opening camera…",
		camHint:
			"Aim at what you want to capture, then hit “Capture into composer”. You can take several shots; add a sentence and send.",
		camShot: "Added to the composer — keep shooting if needed",
		camComposeFailed: "Composer not ready (page still loading?) — try again in a moment",
		camDenied:
			"Camera permission denied: click the 🔒 icon in the address bar, allow camera for this site, then retry — or use the system camera.",
		camUnavailable:
			"Camera could not be opened (no camera on this device, or it is busy). You can use the system camera instead.",
		camInsecure:
			"This page is not a secure context (opened via http://LAN-IP?): the browser disables the camera. Reopen via http://localhost:8787 or http://127.0.0.1:8787 — on phones you can use the system camera instead.",
		camNoFrame: "No frame size yet, try again",
		camTooBig: "Photo stays above 2MB — step back and retry",
		camDecodeFailed: "Image decode failed",
	},
};

/** 当前界面语言（词典里存在的那一个）；解析与回退由 SDK 统一实现。 */
export function detectLang() {
	return createPluginI18n(DICT).locale;
}

/** 取文案函数；语言可以是字符串、undefined（跟随界面）或惰性 getter，每次调用时按当前语言解析。 */
export function makeT(lang) {
	return (key, params) => {
		const current = typeof lang === "function" ? lang() : lang;
		return createPluginI18n(DICT, { locale: current }).t(key, params);
	};
}
