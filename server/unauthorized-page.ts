/**
 * 未授权（401）页：口令表单。
 *
 * 表单必须是**原生 POST** + 账号域(`autocomplete="username"`) + 密码域
 * (`autocomplete="current-password"`)，提交后由 `server/auth-login.ts` 的
 * `POST /__pi/auth` 校验并 303 回跳——只有这样浏览器密码管理器才会提示保存密码。
 * 不要再改成 JS `preventDefault()` + `?token=` 跳转（那样永远不弹保存提示）。
 */
export interface UnauthorizedPageOptions {
	isLoopback: boolean;
	isStaleCookie: boolean;
	port: number;
	/** 上一次表单提交的口令错误（`?auth_error=1`）。 */
	authFailed?: boolean;
	/** 登录成功后的回跳路径（已由 `sanitizeNextPath` 清洗）。 */
	nextPath?: string;
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderUnauthorizedHtml(options: UnauthorizedPageOptions): string {
	const { isLoopback, isStaleCookie, authFailed = false, nextPath = "/" } = options;
	const title = isStaleCookie ? "访问口令已失效" : "需要访问口令";
	const desc = isStaleCookie
		? "服务端口令已变更，浏览器中保存的旧凭证已失效并已自动清除。请输入当前有效口令以重新进入系统。"
		: "当前 pi-web-ui 实例已配置安全口令鉴权 (PI_WEB_TOKEN)。请输入口令以访问工作区。";

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — pi-web-ui</title>
<style>
:root {
	--bg: #090a0f;
	--card-bg: rgba(22, 24, 33, 0.85);
	--card-border: rgba(255, 255, 255, 0.1);
	--input-bg: rgba(13, 14, 20, 0.9);
	--input-border: rgba(255, 255, 255, 0.15);
	--input-focus: #3b82f6;
	--primary: #3b82f6;
	--primary-hover: #2563eb;
	--text: #f3f4f6;
	--text-muted: #9ca3af;
	--text-dim: #6b7280;
	--warning-bg: rgba(245, 158, 11, 0.12);
	--warning-border: rgba(245, 158, 11, 0.3);
	--radius: 10px;
	--radius-lg: 14px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	background-color: var(--bg);
	background-image: 
		radial-gradient(circle at 20% 20%, rgba(59, 130, 246, 0.1) 0%, transparent 40%),
		radial-gradient(circle at 80% 80%, rgba(139, 92, 246, 0.08) 0%, transparent 40%);
	background-attachment: fixed;
	color: var(--text);
	min-height: 100vh;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px 16px;
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
}
.card {
	width: 100%;
	max-width: 480px;
	background: var(--card-bg);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-lg);
	padding: 32px 28px;
	box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
	backdrop-filter: blur(16px);
}
.header {
	display: flex;
	align-items: center;
	gap: 12px;
	margin-bottom: 20px;
}
.icon-box {
	width: 42px;
	height: 42px;
	border-radius: 10px;
	background: rgba(59, 130, 246, 0.15);
	border: 1px solid rgba(59, 130, 246, 0.3);
	display: flex;
	align-items: center;
	justify-content: center;
	color: #60a5fa;
	flex-shrink: 0;
}
.title-group h1 {
	font-size: 18px;
	font-weight: 600;
	color: var(--text);
}
.title-group .sub {
	font-size: 13px;
	color: var(--text-dim);
}
.desc {
	font-size: 14px;
	color: var(--text-muted);
	margin-bottom: 24px;
	line-height: 1.6;
}
.stale-notice {
	background: var(--warning-bg);
	border: 1px solid var(--warning-border);
	border-radius: var(--radius);
	padding: 12px 14px;
	margin-bottom: 20px;
	font-size: 13px;
	color: #fde68a;
	display: flex;
	gap: 10px;
	align-items: flex-start;
}
.stale-notice svg {
	flex-shrink: 0;
	margin-top: 2px;
}
.auth-error {
	background: rgba(239, 68, 68, 0.12);
	border: 1px solid rgba(239, 68, 68, 0.35);
	border-radius: var(--radius);
	padding: 12px 14px;
	margin-bottom: 20px;
	font-size: 13px;
	color: #fecaca;
	line-height: 1.5;
}
.input-row {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin-bottom: 20px;
}
.input-row label {
	font-size: 13px;
	font-weight: 500;
	color: var(--text-muted);
}
.input-wrapper {
	position: relative;
	display: flex;
	align-items: center;
}
.input-row input {
	width: 100%;
	background: var(--input-bg);
	border: 1px solid var(--input-border);
	color: var(--text);
	border-radius: var(--radius);
	padding: 10px 14px;
	font-size: 14px;
	outline: none;
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	transition: border-color 0.15s, box-shadow 0.15s;
}
.input-wrapper input { padding-right: 42px; }
.input-row input:focus {
	border-color: var(--input-focus);
	box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
}
.btn-toggle {
	position: absolute;
	right: 10px;
	background: none;
	border: none;
	color: var(--text-dim);
	cursor: pointer;
	padding: 4px;
	display: flex;
	align-items: center;
}
.btn-toggle:hover { color: var(--text); }
.btn-submit {
	width: 100%;
	background: var(--primary);
	color: #fff;
	border: none;
	border-radius: var(--radius);
	padding: 11px 16px;
	font-size: 14px;
	font-weight: 500;
	cursor: pointer;
	transition: background-color 0.15s;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
}
.btn-submit:hover { background: var(--primary-hover); }
.divider {
	height: 1px;
	background: var(--card-border);
	margin: 24px 0;
}
.loopback-box {
	background: rgba(255, 255, 255, 0.03);
	border: 1px solid rgba(255, 255, 255, 0.06);
	border-radius: var(--radius);
	padding: 14px;
	font-size: 13px;
	color: var(--text-muted);
	display: flex;
	flex-direction: column;
	gap: 10px;
}
.loopback-box p { line-height: 1.5; }
.btn-setup {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	background: rgba(255, 255, 255, 0.08);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: var(--text);
	text-decoration: none;
	padding: 8px 14px;
	border-radius: var(--radius);
	font-size: 13px;
	font-weight: 500;
	transition: background 0.15s;
}
.btn-setup:hover { background: rgba(255, 255, 255, 0.14); }
</style>
<script>
(function() {
	try {
		var saved = localStorage.getItem("pi-web-ui:token");
		var u = new URL(window.location.href);
		if (saved && !u.searchParams.has("__tried_cached_token")) {
			u.searchParams.set("token", saved);
			u.searchParams.set("__tried_cached_token", "1");
			window.location.replace(u.toString());
		}
	} catch(e) {}
})();
</script>
</head>
<body>
<div class="card">
	<div class="header">
		<div class="icon-box">
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
				<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
			</svg>
		</div>
		<div class="title-group">
			<h1>${title}</h1>
			<div class="sub">pi-web-ui 安全访问控制</div>
		</div>
	</div>

	${
		isStaleCookie
			? `<div class="stale-notice">
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<circle cx="12" cy="12" r="10"/>
			<line x1="12" y1="8" x2="12" y2="12"/>
			<line x1="12" y1="16" x2="12.01" y2="16"/>
		</svg>
		<div><strong>服务端口令已变更</strong>：原登录凭据已失效，请输入当前生效的访问口令。</div>
	</div>`
			: ""
	}

	${authFailed ? `<div class="auth-error"><strong>口令不正确</strong>：请核对终端或服务端配置里当前的 PI_WEB_TOKEN 后重试。</div>` : ""}

	<p class="desc">${desc}</p>

	<form id="auth-form" method="post" action="/__pi/auth">
		<input type="hidden" name="next" value="${escapeAttr(nextPath)}">
		<div class="input-row">
			<label for="username-input">账户</label>
			<input id="username-input" name="username" type="text" autocomplete="username" value="pi-web-ui" spellcheck="false" autocapitalize="off">
		</div>
		<div class="input-row">
			<label for="token-input">访问口令 (Token)</label>
			<div class="input-wrapper">
				<input id="token-input" name="token" type="password" autofocus autocomplete="current-password" placeholder="请输入口令或从终端复制">
				<button type="button" id="btn-toggle-eye" class="btn-toggle" title="显示/隐藏口令">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
						<circle cx="12" cy="12" r="3"/>
					</svg>
				</button>
			</div>
		</div>
		<button type="submit" class="btn-submit">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
				<polyline points="10 17 15 12 10 7"/>
				<line x1="15" y1="12" x2="3" y2="12"/>
			</svg>
			进入工作区
		</button>
	</form>

	${
		isLoopback
			? `<div class="divider"></div>
	<div class="loopback-box">
		<p>💡 <strong>本机访问特权</strong>：服务运行在您的本机，您可在启动终端中直接点击带 Token 的链接，或进入配置中心管理口令：</p>
		<a href="/setup" class="btn-setup">
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="12" cy="12" r="3"/>
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
			</svg>
			打开本机配置中心 (/setup)
		</a>
	</div>`
			: ""
	}
</div>

<script>
var input = document.getElementById("token-input");
var eyeBtn = document.getElementById("btn-toggle-eye");
var isPwd = true;
if (eyeBtn && input) {
	eyeBtn.onclick = function() {
		isPwd = !isPwd;
		input.type = isPwd ? "password" : "text";
	};
}

// 原生 POST 提交（不 preventDefault）：浏览器才能识别为一次真实登录并询问是否保存密码。
var form = document.getElementById("auth-form");
if (form && input) {
	form.addEventListener("submit", function() {
		input.value = input.value.trim();
		if (input.type === "text") {
			isPwd = true;
			input.type = "password";
		}
	});
}
</script>
</body>
</html>`;
}
