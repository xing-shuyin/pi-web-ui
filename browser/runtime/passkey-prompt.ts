/**
 * passkey 的本地确认窗口（无边框小窗，出现 → 转一圈 → “已通过” → 自己关掉）。
 *
 * 这是在补 **Electron 没有平台生物识别实现** 这件事的体感：真正的 Windows Hello 做不到，
 * 所以这里明说是「本地确认」，并在 0.9 秒后自动通过——不做假指纹、也不假装做了生物识别。
 * 窗口内容全内联、`data:` URL 加载、无 preload、无 node，只能看不能做别的。
 */
export const PASSKEY_PROMPT_MS = 900;

export interface PasskeyPromptText {
	title: string;
	detail: string;
	done: string;
}

const ZH: PasskeyPromptText = {
	title: "正在验证本机凭据…",
	detail: "本地确认 · 本机无可用生物识别，自动通过",
	done: "已通过",
};

const EN: PasskeyPromptText = {
	title: "Checking your local passkey…",
	detail: "Local confirmation · no biometric hardware, auto-approved",
	done: "Verified",
};

export function passkeyPromptText(language: string): PasskeyPromptText {
	return language.toLowerCase().startsWith("zh") ? ZH : EN;
}

/** 生成小窗的 HTML（纯字符串，方便单测断言“有没有明说是本地确认”）。 */
export function passkeyPromptHtml(language: string): string {
	const text = passkeyPromptText(language);
	const escape = (value: string): string =>
		value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{height:100vh;display:flex;align-items:center;gap:14px;padding:0 18px;
background:#1b1d24;color:#e6e8ee;border:1px solid rgba(255,255,255,.14);border-radius:12px;
font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;
overflow:hidden;user-select:none}
.ring{width:34px;height:34px;border-radius:50%;flex:0 0 auto;
border:2px solid rgba(91,140,255,.28);border-top-color:#5b8cff;animation:spin .7s linear infinite}
body.done .ring{border-color:rgba(76,205,140,.35);border-top-color:#4ccd8c;animation:none}
.mark{position:absolute;left:18px;width:34px;height:34px;display:none;align-items:center;justify-content:center;
color:#4ccd8c;font-size:18px}
body.done .mark{display:flex}
body.done .ring{opacity:.25}
.wrap{position:relative;width:34px;height:34px;flex:0 0 auto}
.text{min-width:0}
.title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.detail{margin-top:2px;color:#9aa1b1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<div class="wrap"><div class="ring"></div><div class="mark">✓</div></div>
<div class="text"><div class="title">${escape(text.title)}</div><div class="detail">${escape(text.detail)}</div></div>
<script>
setTimeout(function () {
  document.body.classList.add("done");
  document.querySelector(".title").textContent = ${JSON.stringify(text.done)};
}, ${Math.round(PASSKEY_PROMPT_MS * 0.6)});
</script>
</body></html>`;
}

export function passkeyPromptDataUrl(language: string): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(passkeyPromptHtml(language))}`;
}
