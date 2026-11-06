export function renderSetupHtml(): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pi-web-ui 本地配置中心</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<style>
:root {
	--bg: #090a0f;
	--card-bg: rgba(22, 24, 33, 0.75);
	--card-border: rgba(255, 255, 255, 0.08);
	--card-border-hover: rgba(255, 255, 255, 0.16);
	--input-bg: rgba(13, 14, 20, 0.85);
	--input-border: rgba(255, 255, 255, 0.12);
	--input-focus: #3b82f6;
	--primary: #3b82f6;
	--primary-hover: #2563eb;
	--text: #f3f4f6;
	--text-muted: #9ca3af;
	--text-dim: #6b7280;
	--success: #10b981;
	--success-bg: rgba(16, 185, 129, 0.12);
	--warning: #f59e0b;
	--warning-bg: rgba(245, 158, 11, 0.12);
	--danger: #ef4444;
	--danger-bg: rgba(239, 68, 68, 0.12);
	--radius-sm: 6px;
	--radius: 10px;
	--radius-lg: 14px;
}
* {
	box-sizing: border-box;
	margin: 0;
	padding: 0;
}
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	background-color: var(--bg);
	background-image: 
		radial-gradient(circle at 15% 15%, rgba(59, 130, 246, 0.08) 0%, transparent 40%),
		radial-gradient(circle at 85% 85%, rgba(139, 92, 246, 0.06) 0%, transparent 40%);
	background-attachment: fixed;
	color: var(--text);
	min-height: 100vh;
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 40px 16px;
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
}
.container {
	width: 100%;
	max-width: 620px;
}
.header {
	margin-bottom: 28px;
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.brand {
	display: flex;
	align-items: center;
	gap: 12px;
}
.brand-icon {
	width: 40px;
	height: 40px;
	border-radius: var(--radius);
	background: linear-gradient(135deg, #3b82f6, #8b5cf6);
	display: flex;
	align-items: center;
	justify-content: center;
	color: #fff;
	box-shadow: 0 4px 14px rgba(59, 130, 246, 0.35);
}
.brand-icon svg {
	width: 22px;
	height: 22px;
}
.brand-text h1 {
	font-size: 20px;
	font-weight: 700;
	letter-spacing: -0.02em;
	color: #fff;
}
.brand-text p {
	font-size: 13px;
	color: var(--text-muted);
}
.sec-badge {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 5px 10px;
	border-radius: 9999px;
	font-size: 12px;
	font-weight: 500;
	background: var(--success-bg);
	color: var(--success);
	border: 1px solid rgba(16, 185, 129, 0.25);
}
.sec-badge svg {
	width: 14px;
	height: 14px;
}
.card {
	background: var(--card-bg);
	backdrop-filter: blur(16px);
	-webkit-backdrop-filter: blur(16px);
	border: 1px solid var(--card-border);
	border-radius: var(--radius-lg);
	padding: 24px;
	box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
	margin-bottom: 20px;
}
.card-title {
	font-size: 15px;
	font-weight: 600;
	color: #fff;
	margin-bottom: 16px;
	display: flex;
	align-items: center;
	gap: 8px;
}
.field-group {
	margin-bottom: 20px;
}
.field-group:last-child {
	margin-bottom: 0;
}
.field-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 6px;
}
label {
	font-size: 13px;
	font-weight: 500;
	color: #e5e7eb;
}
.field-hint {
	font-size: 12px;
	color: var(--text-dim);
	margin-top: 5px;
	line-height: 1.4;
}
.input-wrap {
	position: relative;
	display: flex;
	align-items: center;
}
input {
	width: 100%;
	height: 40px;
	background: var(--input-bg);
	border: 1px solid var(--input-border);
	border-radius: var(--radius);
	padding: 0 12px;
	font-size: 14px;
	color: var(--text);
	transition: all 0.15s ease;
	outline: none;
	font-family: inherit;
}
input:focus {
	border-color: var(--input-focus);
	box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
}
.input-with-actions {
	padding-right: 84px;
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.input-actions {
	position: absolute;
	right: 6px;
	display: flex;
	gap: 4px;
}
.btn-icon {
	background: transparent;
	border: 0;
	color: var(--text-muted);
	padding: 6px;
	border-radius: var(--radius-sm);
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: all 0.15s ease;
}
.btn-icon:hover {
	color: #fff;
	background: rgba(255, 255, 255, 0.1);
}
.btn-icon svg {
	width: 16px;
	height: 16px;
}
.status-pill {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	padding: 2px 8px;
	border-radius: 9999px;
	margin-top: 6px;
}
.status-pill.active {
	background: var(--success-bg);
	color: var(--success);
}
.status-pill.inactive {
	background: var(--warning-bg);
	color: var(--warning);
}
.status-pill.danger {
	background: var(--danger-bg);
	color: var(--danger);
}
.grid-2 {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 16px;
}
@media (max-width: 520px) {
	.grid-2 {
		grid-template-columns: 1fr;
	}
}
.actions-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding-top: 10px;
}
.btn-primary {
	background: var(--primary);
	color: #fff;
	border: 0;
	border-radius: var(--radius);
	padding: 10px 24px;
	font-size: 14px;
	font-weight: 500;
	cursor: pointer;
	transition: background 0.15s ease, transform 0.05s ease;
	display: inline-flex;
	align-items: center;
	gap: 8px;
}
.btn-primary:hover {
	background: var(--primary-hover);
}
.btn-primary:active {
	transform: scale(0.98);
}
.btn-secondary {
	background: rgba(255, 255, 255, 0.08);
	color: var(--text);
	border: 1px solid var(--card-border);
	border-radius: var(--radius);
	padding: 10px 18px;
	font-size: 14px;
	font-weight: 500;
	cursor: pointer;
	text-decoration: none;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	transition: all 0.15s ease;
}
.btn-secondary:hover {
	background: rgba(255, 255, 255, 0.14);
}
.banner {
	padding: 12px 16px;
	border-radius: var(--radius);
	font-size: 13px;
	margin-bottom: 20px;
	display: none;
	animation: fadeIn 0.2s ease;
}
.banner.ok {
	display: flex;
	background: var(--success-bg);
	border: 1px solid rgba(16, 185, 129, 0.3);
	color: #a7f3d0;
}
.banner.err {
	display: flex;
	background: var(--danger-bg);
	border: 1px solid rgba(239, 68, 68, 0.3);
	color: #fca5a5;
}
.banner.warn {
	display: flex;
	background: var(--warning-bg);
	border: 1px solid rgba(245, 158, 11, 0.3);
	color: #fde68a;
}
.banner-content {
	flex: 1;
}
.banner-content strong {
	display: block;
	margin-bottom: 2px;
	color: #fff;
}
.footer-text {
	text-align: center;
	font-size: 12px;
	color: var(--text-dim);
	margin-top: 24px;
	line-height: 1.6;
}
.footer-text code {
	background: rgba(255, 255, 255, 0.08);
	padding: 2px 6px;
	border-radius: 4px;
	color: #e5e7eb;
}
@keyframes fadeIn {
	from { opacity: 0; transform: translateY(-4px); }
	to { opacity: 1; transform: translateY(0); }
}
.toast {
	position: fixed;
	bottom: 24px;
	left: 50%;
	transform: translateX(-50%) translateY(20px);
	background: #1f2937;
	color: #fff;
	padding: 8px 16px;
	border-radius: 9999px;
	font-size: 13px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
	opacity: 0;
	pointer-events: none;
	transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	display: flex;
	align-items: center;
	gap: 6px;
	border: 1px solid rgba(255, 255, 255, 0.1);
}
.toast.show {
	opacity: 1;
	transform: translateX(-50%) translateY(0);
}
</style>
</head>
<body>
<div class="container">
	<div class="header">
		<div class="brand">
			<div class="brand-icon">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
				</svg>
			</div>
			<div class="brand-text">
				<h1>本地配置中心</h1>
				<p>服务启动与安全参数控制台</p>
			</div>
		</div>
		<div class="sec-badge" title="硬门禁守护：非回环/反代请求直接403拦截">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
			</svg>
			仅本机回环
		</div>
	</div>

	<div id="banner" class="banner">
		<div class="banner-content" id="banner-text"></div>
	</div>

	<div class="card">
		<div class="card-title">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
			</svg>
			访问认证 Token
		</div>

		<div class="field-group">
			<div class="field-header">
				<label for="token">访问密钥（Token）</label>
				<button class="btn-icon" id="btn-gen" title="生成高强度随机 Token" type="button" style="font-size:12px;gap:4px;width:auto;padding:2px 8px;">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
						<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
					</svg>
					随机生成
				</button>
			</div>
			<div class="input-wrap">
				<input id="token" type="password" class="input-with-actions" placeholder="留空则允许免密（仅建议本机开发使用）" autocomplete="new-password">
				<div class="input-actions">
					<button class="btn-icon" id="btn-toggle-token" title="显示/隐藏 Token" type="button">
						<svg id="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
							<path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
						</svg>
					</button>
					<button class="btn-icon" id="btn-copy-token" title="复制 Token 链接" type="button">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
							<path stroke-linecap="round" stroke-linejoin="round" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
						</svg>
					</button>
				</div>
			</div>
			<div id="token-status-pill" class="status-pill"></div>
			<p class="field-hint">Token 修改后<b>立即热生效</b>。设置后，外部浏览器请求需携带 Token（自动写入 Cookie 或使用 <code>?token=...</code> 访问）。</p>
		</div>
	</div>

	<div class="card">
		<div class="card-title">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/>
			</svg>
			网络与监听
		</div>

		<div class="grid-2">
			<div class="field-group">
				<label for="host">监听地址（Host）</label>
				<input id="host" placeholder="127.0.0.1">
				<p class="field-hint">127.0.0.1 仅本机；0.0.0.0 允许局域网或外部访问。</p>
			</div>

			<div class="field-group">
				<label for="port">端口（Port）</label>
				<input id="port" inputmode="numeric" placeholder="8787">
				<p class="field-hint">默认 8787。保存后需重启生效。</p>
			</div>
		</div>

		<div class="field-group">
			<label for="allowHosts">Host 白名单</label>
			<input id="allowHosts" placeholder="例如: pi.internal, myserver.local">
			<p class="field-hint">逗号分隔。未配置口令且公网开放时，只允许匹配的 Host 访问；留空使用默认宽松规则。</p>
		</div>

		<div class="field-group">
			<label for="allowOrigins">额外 Origin 白名单</label>
			<input id="allowOrigins" placeholder="例如: https://chat.example.com">
			<p class="field-hint">逗号分隔。主要用于反向代理或跨域嵌入场景。</p>
		</div>
	</div>

	<div class="actions-bar">
		<a id="btn-back" href="/" class="btn-secondary">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
			</svg>
			返回主界面
		</a>
		<button id="save" class="btn-primary" type="button">
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
			</svg>
			保存配置
		</button>
	</div>

	<div class="footer-text">
		配置文件: <code id="config-path">~/.pi-web/server-config.json</code><br>
		提示：命令行参数与环境变量的优先级高于此界面的持久化配置。
	</div>
</div>

<div id="toast" class="toast">
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
		<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
	</svg>
	<span id="toast-text">已复制</span>
</div>

<script>
const $ = id => document.getElementById(id);

function showToast(text) {
	const t = $("toast");
	$("toast-text").textContent = text;
	t.classList.add("show");
	setTimeout(() => t.classList.remove("show"), 2000);
}

function showBanner(type, title, desc) {
	const b = $("banner");
	b.className = "banner " + type;
	$("banner-text").innerHTML = "<strong>" + title + "</strong>" + (desc ? "<span>" + desc + "</span>" : "");
}

function updateTokenPill(tokenSet, warning) {
	const p = $("token-status-pill");
	if (!tokenSet) {
		p.className = "status-pill inactive";
		p.textContent = "● 当前未设置 Token（免密模式）";
	} else if (warning) {
		p.className = "status-pill danger";
		p.textContent = "● " + warning;
	} else {
		p.className = "status-pill active";
		p.textContent = "● Token 保护中（状态良好）";
	}
}

// 密码框显示/隐藏
let pwdVisible = false;
$("btn-toggle-token").onclick = () => {
	pwdVisible = !pwdVisible;
	$("token").type = pwdVisible ? "text" : "password";
	$("eye-icon").innerHTML = pwdVisible 
		? '<path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"/>'
		: '<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>';
};

// 随机生成 32 位 Token
$("btn-gen").onclick = () => {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
	const arr = new Uint8Array(28);
	window.crypto.getRandomValues(arr);
	let token = "";
	for (let i = 0; i < arr.length; i++) token += chars[arr[i] % chars.length];
	$("token").value = token;
	$("token").type = "text";
	pwdVisible = true;
	updateTokenPill(true, "");
	showToast("已生成随机 Token");
};

// 复制带 Token 的入口链接
$("btn-copy-token").onclick = () => {
	const t = $("token").value.trim();
	const base = window.location.origin;
	const url = t ? (base + "/?token=" + encodeURIComponent(t)) : base;
	navigator.clipboard.writeText(url).then(() => {
		showToast(t ? "已复制免密登录直达链接" : "已复制主页链接");
	}).catch(() => {
		showToast("复制失败，请手动选取");
	});
};

// 加载初始状态
fetch("/api/setup/status")
	.then(r => {
		if (!r.ok) throw new Error(r.status + " " + r.statusText);
		return r.json();
	})
	.then(s => {
		$("host").value = s.host || "";
		$("port").value = s.port || "";
		$("allowHosts").value = s.allowHosts || "";
		$("allowOrigins").value = s.allowOrigins || "";
		if (s.token) {
			$("token").value = s.token;
		}
		updateTokenPill(s.tokenSet, s.tokenWarning);
		if (s.configFile) $("config-path").textContent = s.configFile;
		if (s.token) {
			$("btn-back").href = "/?token=" + encodeURIComponent(s.token);
		}
	})
	.catch(e => {
		showBanner("err", "读取配置状态失败", e.message);
	});

// 保存配置
$("save").onclick = () => {
	const saveBtn = $("save");
	saveBtn.disabled = true;
	saveBtn.textContent = "保存中...";

	const tokenVal = $("token").value;
	fetch("/api/setup/save", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			token: tokenVal,
			host: $("host").value,
			port: $("port").value,
			allowHosts: $("allowHosts").value,
			allowOrigins: $("allowOrigins").value
		})
	})
	.then(r => r.json().then(j => ({ st: r.status, j })))
	.then(({ st, j }) => {
		saveBtn.disabled = false;
		saveBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> 保存配置';
		if (!j.ok) {
			showBanner("err", "保存失败", j.error || st);
			return;
		}
		const t = tokenVal.trim();
		updateTokenPill(Boolean(t), t.length > 0 && t.length < 8 ? "口令短于 8 字符，局域网暴露时建议更长。" : "");
		if (t) {
			$("btn-back").href = "/?token=" + encodeURIComponent(t);
		} else {
			$("btn-back").href = "/";
		}
		if (j.restartRequired) {
			showBanner("warn", "配置已保存", "Token 已热生效。监听地址、端口或白名单修改需重启服务后生效（pi-web-ui server restart）。");
		} else {
			showBanner("ok", "配置已保存并生效", "Token 已成功应用至当前运行中的服务。");
		}
		showToast("保存成功");
	})
	.catch(e => {
		saveBtn.disabled = false;
		saveBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> 保存配置';
		showBanner("err", "请求失败", e.message);
	});
};
</script>
</body>
</html>`;
}
