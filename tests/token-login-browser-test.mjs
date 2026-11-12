/**
 * 未登录页「保存密码」链路的真浏览器验收（真实 Chromium + 真实 HTTP）。
 *
 * 能断言什么：浏览器密码管理器**弹气泡的前提条件**全都在这里——表单有
 * `autocomplete=username` 的账号域与 `autocomplete=current-password` 的密码域、提交是一次
 * 真实的 POST 导航、服务端回 303、口令不出现在地址栏、cookie 是持久 + HttpOnly。
 *
 * 不能断言什么：「保存密码」气泡本身是浏览器 chrome 层的 UI，既不在页面 DOM 里，headless
 * 模式也根本不渲。所以这里断言"浏览器识别为一次登录"的全部机器可验信号，气泡外观靠人工过一眼
 * （清空该站点的「永不保存」记录后输一次口令即可）。
 */
import { mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const chrome = CHROME_PATH;
if (!chrome) {
	console.log("SKIP: Chrome unavailable");
	process.exit(0);
}
const TOKEN = "browser-login-token-xyz";
const port = 8900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-login-browser-"));
const log = openSync(join(dataDir, "server.log"), "a");

const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: root,
	env: {
		...process.env,
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_PORT: String(port),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_TOKEN: TOKEN,
		PI_WEB_PLUGIN_CATALOG_URL: "off",
		PI_WEB_SDK: "bundled",
	},
	stdio: ["ignore", log, log],
	windowsHide: true,
});

let passed = 0;
let failed = 0;
function check(name, condition, extra = "") {
	if (condition) {
		passed++;
		console.log(`  ok - ${name}`);
	} else {
		failed++;
		console.error(`  FAIL - ${name} ${extra}`);
	}
}

let browser;
try {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(`${base}/api/health`)).ok) break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (attempt === 99) throw new Error("server did not start");
	}

	browser = await chromium.launch({ executablePath: chrome, headless: true });

	// ---- 1. 未登录页：浏览器识别登录表单需要的全部输入条件 ----
	const context = await browser.newContext();
	const page = await context.newPage();
	const response = await page.goto(base);
	check("未登录页返回 401", response?.status() === 401, String(response?.status()));
	await page.locator("#token-input").waitFor();

	const form = await page.evaluate(() => {
		const node = document.getElementById("auth-form");
		const token = document.getElementById("token-input");
		const user = document.getElementById("username-input");
		return {
			method: node?.getAttribute("method"),
			action: node?.getAttribute("action"),
			passwordType: token?.getAttribute("type"),
			passwordAutocomplete: token?.getAttribute("autocomplete"),
			passwordName: token?.getAttribute("name"),
			usernameAutocomplete: user?.getAttribute("autocomplete"),
			usernameName: user?.getAttribute("name"),
			passwordInsideForm: token?.form?.id === "auth-form",
		};
	});
	check("表单是原生 POST 提交", form.method === "post" && form.action === "/__pi/auth", JSON.stringify(form));
	check(
		"密码域 autocomplete=current-password（浏览器启发式的必要条件）",
		form.passwordAutocomplete === "current-password" &&
			form.passwordType === "password" &&
			form.passwordName === "token",
		JSON.stringify(form),
	);
	check(
		"账号域 autocomplete=username（保存密码要能配对账号）",
		form.usernameAutocomplete === "username" && form.usernameName === "username",
		JSON.stringify(form),
	);
	check("密码域在 form 内（气泡要求它是表单的一部分）", form.passwordInsideForm === true);

	// ---- 2. 真提交：POST 导航 + 303 + 地址栏不放口令 ----
	const requests = [];
	const authResponses = [];
	page.on("request", (request) => {
		if (request.url().includes("/__pi/auth")) {
			requests.push({ method: request.method(), postData: request.postData(), type: request.resourceType() });
		}
	});
	page.on("response", (res) => {
		if (res.url().includes("/__pi/auth"))
			authResponses.push({ status: res.status(), location: res.headers().location });
	});

	// 先用眼睛开关把 type 切成 text，再提交：服务端仍必须拿到密码域
	await page.click("#btn-toggle-eye");
	check("眼睛开关把密码框切成 text", (await page.getAttribute("#token-input", "type")) === "text");
	await page.fill("#token-input", TOKEN);
	await Promise.all([page.waitForNavigation({ waitUntil: "commit" }), page.click("#auth-form button[type=submit]")]);
	await page.waitForLoadState("domcontentloaded");

	check(
		"提交是一次真实 POST 导航（浏览器据此判定为登录）",
		requests.length === 1 && requests[0].method === "POST" && requests[0].type === "document",
		JSON.stringify(requests),
	);
	check(
		"POST 体里带口令（表单序列化，不是 JS 拼 URL）",
		String(requests[0]?.postData ?? "").includes(`token=${encodeURIComponent(TOKEN)}`),
		String(requests[0]?.postData),
	);
	check("服务端回 303 跳转", authResponses[0]?.status === 303, JSON.stringify(authResponses));
	check("跳转目标不含 token 参数（口令不进地址栏/历史）", !page.url().includes("token="), page.url());
	check("落地在应用根路径", new URL(page.url()).pathname === "/", page.url());

	const cookies = await context.cookies(base);
	const cookie = cookies.find((item) => item.name === "pi_web_token");
	check("登录后拿到 pi_web_token cookie", Boolean(cookie), JSON.stringify(cookies.map((item) => item.name)));
	check("cookie 是 HttpOnly（渲染层拿不到口令）", cookie?.httpOnly === true, JSON.stringify(cookie));
	check(
		"cookie 是持久 cookie（对应「记住我」，关浏览器不失效）",
		typeof cookie?.expires === "number" && cookie.expires * 1000 > Date.now() + 24 * 3600 * 1000,
		String(cookie?.expires),
	);

	// ---- 3. 带 cookie 直接导航不再要求口令 ----
	const reloaded = await page.goto(base);
	check("带 cookie 重新加载 → 200（不必再输口令）", reloaded?.status() === 200, String(reloaded?.status()));
	check("页面不再是未登录页", (await page.locator("#token-input").count()) === 0);
	await context.close();

	// ---- 4. 错口令：回到错误页并给出提示 ----
	const badContext = await browser.newContext();
	const badPage = await badContext.newPage();
	await badPage.goto(base);
	await badPage.fill("#token-input", "definitely-wrong");
	await Promise.all([
		badPage.waitForNavigation({ waitUntil: "commit" }),
		badPage.click("#auth-form button[type=submit]"),
	]);
	await badPage.waitForLoadState("domcontentloaded");
	const badUrl = new URL(badPage.url());
	check("错口令回到原路径并带 auth_error", badUrl.searchParams.get("auth_error") === "1", badPage.url());
	check(
		"错口令页面提示口令不正确",
		await badPage
			.locator(".auth-error")
			.isVisible()
			.catch(() => false),
	);
	check(
		"错口令不下发 cookie",
		(await badContext.cookies(base)).every((item) => item.name !== "pi_web_token" || !item.value),
	);
	await badContext.close();

	console.log(`\n${passed} passed, ${failed} failed`);
} catch (error) {
	failed++;
	console.error("test crashed:", error);
} finally {
	await browser?.close().catch(() => {});
	server.kill("SIGTERM");
	process.exit(failed === 0 ? 0 : 1);
}
