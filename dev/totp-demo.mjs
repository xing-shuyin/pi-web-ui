#!/usr/bin/env node
/**
 * 本地 2FA 测试站：给内置浏览器的「TOTP 验证器」跑一遍 **扫码绑定 / 按站点自动匹配 / 一键填码 / 服务端校验**。
 *
 * 用法：
 *   node dev/totp-demo.mjs                 # 默认 http://127.0.0.1:8791
 *   node dev/totp-demo.mjs --port 8811     # 换端口
 *   PI_TOTP_SECRET=JBSWY3DPEHPK3PXP node dev/totp-demo.mjs   # 固定 demo 账号密钥（默认每次启动随机）
 *
 * 页面（都在同一个 origin，扫码记下的 origin 才能自动匹配到登录页）：
 *   /                入口索引 + 实时验证码
 *   /setup[/:key]    二维码（扫码绑定的源）   ← 先在这里扫码
 *   /login[/:key]    标准登录页（input autocomplete="one-time-code"）
 *   /login-cells/:key 分格验证码（6 个 maxlength=1 输入框，覆盖逐格填码路径）
 *   /login-plain/:key 无任何提示的单框（覆盖「先点输入框再填」路径）
 *   /verify          表单 POST 目标：真的按 TOTP 规则校验（含 ±1 个时间窗漂移）
 *   /api/code/:key   当前验证码 JSON（页面轮询用，也方便自己 curl 对答案）
 *
 * 只监听回环地址，没有任何第三方服务，纯本地演示。
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import QRCode from "qrcode";

/* ---------------------------------- TOTP ---------------------------------- */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 Base32 编码（生产侧只需要解码，这里要造密钥）。 */
function base32Encode(bytes) {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32[(value >> bits) & 31];
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

function base32Decode(input) {
	const clean = String(input).replace(/[\s-]/g, "").replace(/=+$/g, "").toUpperCase();
	const bytes = [];
	let buffer = 0;
	let bits = 0;
	for (const char of clean) {
		const index = BASE32.indexOf(char);
		if (index < 0) throw new Error(`bad base32 char ${char}`);
		buffer = (buffer << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((buffer >> bits) & 0xff);
		}
	}
	return Buffer.from(bytes);
}

function hotp(secret, counter, digits, algorithm) {
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac(algorithm.toLowerCase(), base32Decode(secret)).update(message).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const binary =
		((digest[offset] & 0x7f) << 24) |
		((digest[offset + 1] & 0xff) << 16) |
		((digest[offset + 2] & 0xff) << 8) |
		(digest[offset + 3] & 0xff);
	return String(binary % 10 ** digits).padStart(digits, "0");
}

function codeAt(account, nowMs = Date.now()) {
	const periodMs = account.period * 1000;
	return {
		code: hotp(account.secret, Math.floor(nowMs / periodMs), account.digits, account.algorithm),
		remainingMs: periodMs - (nowMs % periodMs),
		period: account.period,
	};
}

/** 校验：允许前后各一个时间窗（真实 2FA 服务的常规宽容度）。 */
function verifyCode(account, input, nowMs = Date.now()) {
	const value = String(input ?? "").trim();
	const periodMs = account.period * 1000;
	const counter = Math.floor(nowMs / periodMs);
	for (const drift of [0, -1, 1]) {
		const expected = hotp(account.secret, counter + drift, account.digits, account.algorithm);
		if (value === expected) return { ok: true, drift };
	}
	return { ok: false, drift: 0, expected: codeAt(account, nowMs).code };
}

/* --------------------------------- 账号表 --------------------------------- */

function makeAccount(key, issuer, extra = {}) {
	const { fixedSecret, ...rest } = extra;
	return {
		key,
		issuer,
		account: "demo@pi-web-ui.local",
		secret: (fixedSecret && process.env.PI_TOTP_SECRET) || base32Encode(randomBytes(20)),
		algorithm: "SHA1",
		digits: 6,
		period: 30,
		...rest,
	};
}

const ACCOUNTS = [
	// 主账号：SHA1 / 6 位 / 30 秒，扫码绑定 + 自动匹配就用它
	makeAccount("demo", "Pi Web Demo", { fixedSecret: true }),
	// 非默认算法：确认 otpauth URI 里的 algorithm 参数被正确解析
	makeAccount("sha256", "Pi Web Demo 256", { algorithm: "SHA256" }),
	// 非默认位数 + 周期：确认 digits / period 参数被正确解析
	makeAccount("long", "Pi Web Demo Long", { digits: 8, period: 60 }),
];

const accountByKey = (key) => ACCOUNTS.find((item) => item.key === key) ?? ACCOUNTS[0];

const otpauthUri = (item) => {
	const label = `${item.issuer}:${item.account}`;
	const params = new URLSearchParams({ secret: item.secret, issuer: item.issuer });
	if (item.algorithm !== "SHA1") params.set("algorithm", item.algorithm);
	if (item.digits !== 6) params.set("digits", String(item.digits));
	if (item.period !== 30) params.set("period", String(item.period));
	return `otpauth://totp/${encodeURIComponent(label)}?${params}`;
};

/* --------------------------------- 页面骨架 -------------------------------- */

const CSS = `
:root { color-scheme: light dark; --line: #d5d9e0; --dim: #6b7280; --ok: #15803d; --bad: #b91c1c; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: flex-start;
	font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
	background: #f5f6f8; color: #111827; }
main { width: min(720px, 100%); margin: 40px 16px; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 24px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 24px 0 8px; }
p.sub { margin: 0 0 20px; color: var(--dim); }
label { display: block; margin: 14px 0 6px; font-weight: 600; }
input[type="text"], input[type="password"], input[type="email"] { width: 100%; padding: 10px 12px; font-size: 16px;
	border: 1px solid var(--line); border-radius: 8px; background: #fff; color: inherit; }
input:focus { outline: 2px solid #6366f1; outline-offset: 1px; }
button { margin-top: 20px; padding: 10px 18px; font-size: 15px; font-weight: 600; color: #fff; background: #4f46e5;
	border: 0; border-radius: 8px; cursor: pointer; }
button:hover { background: #4338ca; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.code-big { font: 600 30px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 4px; }
.cells { display: flex; gap: 8px; }
.cells input { width: 46px; padding: 8px 0; text-align: center; font: 600 20px/1.2 ui-monospace, Menlo, monospace;
	border: 1px solid var(--line); border-radius: 8px; }
.bar { height: 4px; background: var(--line); border-radius: 999px; overflow: hidden; margin-top: 8px; }
.bar > i { display: block; height: 100%; background: #6366f1; width: 100%; }
ul.links { list-style: none; padding: 0; margin: 8px 0 0; }
ul.links li { padding: 8px 0; border-top: 1px solid var(--line); }
ul.links a { color: #4f46e5; text-decoration: none; font-weight: 600; }
ul.links span { color: var(--dim); }
.result { padding: 12px 14px; border-radius: 8px; border: 1px solid; margin-bottom: 16px; }
.result.ok { color: var(--ok); border-color: #86efac; background: #f0fdf4; }
.result.bad { color: var(--bad); border-color: #fca5a5; background: #fef2f2; }
.meta { color: var(--dim); font-size: 13px; word-break: break-all; }
.qr { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.qr img { width: 200px; height: 200px; image-rendering: pixelated; border: 8px solid #fff; border-radius: 8px; }
.hint { margin-top: 20px; padding: 12px 14px; border-left: 3px solid #6366f1; background: #eef2ff; border-radius: 0 8px 8px 0; }
@media (prefers-color-scheme: dark) {
	body { background: #0f1115; color: #e5e7eb; }
	.card { background: #171a21; border-color: #2b303b; }
	input { background: #0f1115 !important; border-color: #2b303b !important; color: inherit; }
	ul.links li { border-color: #2b303b; }
	.hint { background: #1e1b4b; }
	.result.ok { background: #052e16; }
	.result.bad { background: #450a0a; }
}
`;

function layout(title, body, script = "") {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<main><div class="card">${body}</div></main>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

/** 实时码小部件（演示站自己显示当前正确码，方便对照填进去的对不对）。 */
const liveCodeWidget = (key) => `
<div class="hint">
	<div class="meta">演示用：服务端此刻认为的正确验证码（自动化填码后对照用）</div>
	<div class="code-big" id="live-code">------</div>
	<div class="bar"><i id="live-bar"></i></div>
	<div class="meta" id="live-meta"></div>
</div>
<script>
	const key = ${JSON.stringify(key)};
	const codeEl = document.getElementById("live-code");
	const barEl = document.getElementById("live-bar");
	const metaEl = document.getElementById("live-meta");
	async function tick() {
		try {
			const res = await fetch("/api/code/" + key, { cache: "no-store" });
			const data = await res.json();
			codeEl.textContent = data.code;
			barEl.style.width = Math.round((data.remainingMs / (data.period * 1000)) * 100) + "%";
			metaEl.textContent = data.algorithm + " · " + data.digits + " 位 · " + data.period + "s · 剩余 " +
				Math.ceil(data.remainingMs / 1000) + "s";
		} catch (error) {
			metaEl.textContent = "取码失败：" + error.message;
		}
	}
	tick();
	setInterval(tick, 1000);
</script>`;

function loginForm(action, fields, submit = "登录") {
	return `<form method="post" action="${action}">
	<label for="username">用户名</label>
	<input id="username" name="username" type="text" autocomplete="username" value="demo@pi-web-ui.local">
	<label for="password">密码</label>
	<input id="password" name="password" type="password" autocomplete="current-password" value="demo-password">
	${fields}
	<button type="submit">${submit}</button>
</form>`;
}

/** 标准验证码框：插件走 `autocomplete="one-time-code"` 直填。 */
const OTP_STANDARD = `<label for="code">验证码</label>
	<input id="code" name="code" type="text" autocomplete="one-time-code" inputmode="numeric"
		placeholder="${"{digits}"}" style="letter-spacing:3px">`;

/** 分格验证码：插件走「一串 maxlength=1」逐格填。 */
const OTP_CELLS = `<label>验证码（分格）</label>
	<div class="cells">
		${Array.from({ length: 6 }, (_, index) => `<input type="text" inputmode="numeric" maxlength="1" autocomplete="off" data-cell="${index}">`).join("")}
	</div>
	<input type="hidden" name="code" id="code-cells">`;

const CELLS_SCRIPT = `
	const cells = [...document.querySelectorAll("[data-cell]")];
	const hidden = document.getElementById("code-cells");
	const sync = () => { hidden.value = cells.map((cell) => cell.value.trim()).join(""); };
	for (const [index, cell] of cells.entries()) {
		cell.addEventListener("input", () => {
			cell.value = cell.value.replace(/\\D/g, "").slice(0, 1);
			if (cell.value && cells[index + 1]) cells[index + 1].focus();
			sync();
		});
		cell.addEventListener("keydown", (event) => {
			if (event.key === "Backspace" && !cell.value && cells[index - 1]) cells[index - 1].focus();
		});
	}
	document.querySelector("form").addEventListener("submit", (event) => {
		sync();
		if (!hidden.value) event.preventDefault();
	});
`;

/** 无提示单框：`name/id/placeholder/aria-label` 里都没有 otp/code 之类的关键词，测兜底路径。 */
const OTP_PLAIN = `<label for="field2">验证码（无任何自动填充提示）</label>
	<input id="field2" name="field2" type="text" autocomplete="off" placeholder="">`;

/* --------------------------------- 页面渲染 -------------------------------- */

function indexPage() {
	const links = ACCOUNTS.map(
		(
			item,
		) => `<li><a href="/setup/${item.key}">扫码绑定 ${item.issuer}</a> <span>（${item.algorithm} · ${item.digits} 位 · ${item.period}s）→ 再进
			<a href="/login/${item.key}">标准登录</a> · <a href="/login-cells/${item.key}">分格</a> · <a href="/login-plain/${item.key}">无提示</a></span></li>`,
	).join("");
	return layout(
		"本地 TOTP 测试站",
		`<h1>本地 TOTP 测试站</h1>
		<p class="sub">给内置浏览器的「TOTP 验证器」跑一遍：扫码绑定 → 按站点自动匹配 → 一键填码 → 服务端校验。</p>
		${liveCodeWidget("demo")}
		<h2>标准路径（推荐先走这条）</h2>
		<ul class="links">
			<li><a href="/setup/demo">1. 打开二维码页</a> <span>在 TOTP 面板点「扫码」把码收进去，绑定 origin = 本机</span></li>
			<li><a href="/login/demo">2. 标准登录页</a> <span>面板里点「填入」应直接落到 autocomplete="one-time-code" 的框</span></li>
		</ul>
		<h2>填码兜底路径</h2>
		<ul class="links">
			<li><a href="/login-cells/demo">分格验证码</a> <span>6 个 maxlength=1 输入框，测逐格填码</span></li>
			<li><a href="/login-plain/demo">无提示单框</a> <span>没有 otp/code 关键词，需先点一下输入框再填</span></li>
		</ul>
		<h2>其它账号（测算法 / 位数 / 周期参数解析）</h2>
		<ul class="links">${links}</ul>
		<h2>接口</h2>
		<ul class="links">
			<li><a href="/api/code/demo">/api/code/demo</a> <span>当前码 + 剩余毫秒（也方便 curl 对答案）</span></li>
			<li><a href="/api/account/demo">/api/account/demo</a> <span>密钥 / otpauth URI（手动导入用）</span></li>
		</ul>`,
	);
}

function setupPage(item) {
	const uri = otpauthUri(item);
	return layout(
		`扫码绑定 · ${item.issuer}`,
		`<h1>扫码绑定 ${item.issuer}</h1>
		<p class="sub">在浏览器的 TOTP 面板点「扫码」——它截当前标签页找码，所以二维码要在视口内可见。</p>
		<div class="qr">
			<div><img alt="otpauth QR" src="/qr/${item.key}.png"><div class="meta">${item.algorithm} · ${item.digits} 位 · ${item.period}s</div></div>
			<div style="flex:1;min-width:280px">
				<div class="meta">手动导入（面板里选「手工添加」粘这段）：</div>
				<div class="mono" style="word-break:break-all;font-size:12px">${uri.replace(/&/g, "&amp;")}</div>
				<div class="meta" style="margin-top:10px">密钥：<span class="mono">${item.secret}</span></div>
				<div class="meta">绑定后 origin 记成 <span class="mono">http://127.0.0.1:PORT</span>，登录页同源，所以会自动匹配。</div>
			</div>
		</div>
		${liveCodeWidget(item.key)}
		<p class="sub" style="margin-top:20px">下一步：<a href="/login/${item.key}">标准登录页</a> · <a href="/">返回索引</a></p>`,
	);
}

/** 各变体的页面路径（索引链接、验证结果页「再来一次」都从这里取）。 */
const variantPath = (item, variant) =>
	variant === "cells"
		? `/login-cells/${item.key}`
		: variant === "plain"
			? `/login-plain/${item.key}`
			: `/login/${item.key}`;

function loginPage(item, variant) {
	const titles = {
		standard: "标准登录（autocomplete=one-time-code）",
		cells: "登录（分格验证码）",
		plain: "登录（无提示输入框）",
	};
	const notes = {
		standard: '验证码框带 autocomplete="one-time-code"，TOTP 面板「填入」的第一优先级。',
		cells: "6 个 maxlength=1 的格子，插件按格逐个填。",
		plain: "输入框没有任何 otp/code 提示，插件需要你先把光标点进框里。",
	};
	const fields = variant === "cells" ? OTP_CELLS : variant === "plain" ? OTP_PLAIN : OTP_STANDARD;
	return layout(
		`${item.issuer} 登录`,
		`<h1>${item.issuer} 登录</h1>
		<p class="sub">${titles[variant]} · ${notes[variant]}</p>
		${loginForm(`/verify/${item.key}/${variant}`, fields.replace("{digits}", String(item.digits)))}
		${liveCodeWidget(item.key)}
		<p class="sub" style="margin-top:20px"><a href="/setup/${item.key}">二维码</a> · <a href="/">返回索引</a></p>`,
		variant === "cells" ? CELLS_SCRIPT : "",
	);
}

function verifyPage(item, variant, input) {
	const result = verifyCode(item, input);
	const current = codeAt(item);
	const driftText = result.ok
		? result.drift === 0
			? "当前时间窗"
			: `${result.drift > 0 ? "后" : "前"}一个时间窗（时钟漂移容错）`
		: "不匹配";
	return layout(
		"校验结果",
		`<h1>校验结果</h1>
		<div class="result ${result.ok ? "ok" : "bad"}">
			<strong>${result.ok ? "✅ 验证通过" : "❌ 验证失败"}</strong><br>
			<span class="meta">提交的码：<span class="mono">${String(input || "(空)")}</span> · 服务端当前码：<span class="mono">${current.code}</span> · ${driftText}</span>
		</div>
		<p class="sub">账号 ${item.issuer}（${item.algorithm} · ${item.digits} 位 · ${item.period}s）。真实 2FA 里这一步就是「登录成功 / 请重试」的分叉点。</p>
		<p class="sub"><a href="${variantPath(item, variant)}">再来一次</a> · <a href="/">返回索引</a></p>`,
	);
}

function notFound(pathname) {
	return layout(
		"404",
		`<h1>404</h1><p class="sub">没有 <span class="mono">${pathname}</span>，去 <a href="/">索引页</a>。</p>`,
	);
}

/* ---------------------------------- 路由 ---------------------------------- */

async function qrPng(uri) {
	const dataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 400, errorCorrectionLevel: "M" });
	return Buffer.from(dataUrl.split(",")[1], "base64");
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

const html = (response, body, status = 200) => {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end(body);
};
const json = (response, data, status = 200) => {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(data, null, 2));
};

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	const pathname = url.pathname.replace(/\/+$/, "") || "/";
	const segments = pathname.split("/").filter(Boolean);

	if (request.method === "POST" && segments[0] === "verify") {
		const item = accountByKey(segments[1]);
		const variant = segments[2] ?? "standard";
		const form = new URLSearchParams(await readBody(request));
		return html(response, verifyPage(item, variant, form.get("code") ?? ""));
	}

	if (request.method !== "GET") {
		response.writeHead(405, { allow: "GET, POST" });
		return response.end();
	}

	if (pathname === "/") return html(response, indexPage());

	if (segments[0] === "api" && segments[1] === "code") {
		const item = accountByKey(segments[2]);
		const current = codeAt(item);
		return json(response, {
			issuer: item.issuer,
			account: item.account,
			algorithm: item.algorithm,
			digits: item.digits,
			period: item.period,
			code: current.code,
			remainingMs: current.remainingMs,
			uri: otpauthUri(item),
		});
	}

	if (segments[0] === "api" && segments[1] === "account") {
		const item = accountByKey(segments[2]);
		return json(response, {
			issuer: item.issuer,
			account: item.account,
			secret: item.secret,
			algorithm: item.algorithm,
			digits: item.digits,
			period: item.period,
			uri: otpauthUri(item),
		});
	}

	if (segments[0] === "qr" && segments[1]) {
		const key = segments[1].replace(/\.png$/, "");
		const png = await qrPng(otpauthUri(accountByKey(key)));
		response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
		return response.end(png);
	}

	if (segments[0] === "setup") return html(response, setupPage(accountByKey(segments[1])));
	const variants = { login: "standard", "login-cells": "cells", "login-plain": "plain" };
	if (variants[segments[0]]) return html(response, loginPage(accountByKey(segments[1]), variants[segments[0]]));

	return html(response, notFound(pathname), 404);
});

/* ---------------------------------- 启动 ---------------------------------- */

const portArg = process.argv.indexOf("--port");
const port = Number((portArg > 0 ? process.argv[portArg + 1] : undefined) ?? process.env.PI_TOTP_PORT ?? 8791);

server.listen(port, "127.0.0.1", () => {
	const origin = `http://127.0.0.1:${port}`;
	console.log(`\n本地 TOTP 测试站: ${origin}\n`);
	for (const item of ACCOUNTS) {
		const current = codeAt(item);
		console.log(
			`  ${item.issuer.padEnd(18)} ${item.algorithm} ${item.digits} 位 ${String(item.period).padStart(3)}s` +
				`  secret=${item.secret}  当前码=${current.code}  (${current.remainingMs}ms 后轮换)`,
		);
	}
	console.log(`\n  扫码绑定: ${origin}/setup/demo`);
	console.log(`  标准登录: ${origin}/login/demo`);
	console.log(`  分格填码: ${origin}/login-cells/demo`);
	console.log(`  无提示框: ${origin}/login-plain/demo\n`);
});
