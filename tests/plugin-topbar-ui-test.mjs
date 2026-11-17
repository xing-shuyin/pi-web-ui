import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-topbar-ui-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const PORT = 20000 + Math.floor(Math.random() * 8000);
mkdirSync(WORK, { recursive: true });

let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

const pdir = join(DATA_DIR, "plugins", "toptest");
mkdirSync(join(pdir, "client"), { recursive: true });
writeFileSync(
	join(pdir, "manifest.json"),
	JSON.stringify({
		name: "Top Test",
		version: "0.0.1",
		view: false,
		permissions: ["ui"],
		ui: {
			topbar: [
				{ id: "ping", label: "Ping Me", kind: "action", action: "toptest:ping" },
				{ id: "hidden-one", label: "Hidden One", kind: "action", action: "toptest:ping", hidden: true },
			],
		},
	}),
);
writeFileSync(
	join(pdir, "client", "entry.mjs"),
	`window.__piWebUiHost?.onTopbarAction?.("toptest:ping", () => { document.title = "TOPBAR-ACTION-OK"; });
export default { mount(container) { container.textContent = "toptest"; } };
`,
);

let server;
let browser;
let passedChecks = 0;

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: WORK, PI_WEB_DATA_DIR: DATA_DIR },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
	const errors = [];
	const jobFrames = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	page.on("websocket", (ws) => {
		ws.on("framesent", (f) => {
			const s = String(f.payload);
			if (s.includes('"type":"plugin_job"')) jobFrames.push({ dir: "out", s });
		});
		ws.on("framereceived", (f) => {
			const s = String(f.payload);
			if (s.includes('"type":"plugin_job"')) jobFrames.push({ dir: "in", s: s.slice(0, 400) });
		});
	});

	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	// 插件顶栏项现在统一走 bar-item 渲染层（data-bar-item="<pluginId>:<itemId>"），
	// 旧的 .plugin-topbar-item 只剩「更多」溢出按钮在用（bar-item-unified 守卫）。
	const pluginBtn = page.locator('.bar-item[data-bar-item="toptest:ping"]').first();
	await pluginBtn.waitFor({ timeout: 20000 }).catch(() => {});
	const label = await pluginBtn.textContent().catch(() => "");
	check("插件声明的顶栏按钮渲染在宿主顶栏", (label ?? "").includes("Ping Me"));

	await pluginBtn.click();
	let actionOk = false;
	for (let i = 0; i < 60; i++) {
		if ((await page.title()) === "TOPBAR-ACTION-OK") {
			actionOk = true;
			break;
		}
		await sleep(100);
	}
	check("点击后插件接管的动作被执行（按需加载 client bundle）", actionOk);

	const settingsBtn = page
		.locator(
			'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
		)
		.first();
	if (await settingsBtn.count()) await settingsBtn.click();
	await sleep(800);
	// 设置面板现在是「插件」总页 + 两个 smart-tab 分页：安装的插件 / 插件市场
	const pluginsTab = page.locator(".settings-tab", { hasText: /^插件|^Plugins/ }).first();
	if (await pluginsTab.count()) await pluginsTab.click();
	await sleep(600);
	check("设置面板出现「插件」页与两个分页", (await page.locator(".smart-tab-pill").count()) >= 2);

	const marketPill = page.locator(".smart-tab-pill", { hasText: /插件市场|Plugin market/ }).first();
	if (await marketPill.count()) await marketPill.click();
	await sleep(600);
	check("插件市场出现「源码构建」勾选项", (await page.getByText("源码构建", { exact: false }).count()) > 0);

	const installedSub = page.locator(".smart-tab-pill", { hasText: /安装的插件|已安装|Installed/ }).first();
	if (await installedSub.count()) await installedSub.click();
	await sleep(600);

	// 安装列表现在是独立面板（InstalledPluginsPanel）：卸载按钮是 .ip-btn-danger，两步确认同一按钮改文案
	const uninstallBtn = page.locator(".ip-btn-danger", { hasText: /卸载|Uninstall/ }).first();
	check("插件列表有卸载按钮", (await uninstallBtn.count()) > 0);
	if (await uninstallBtn.count()) {
		await uninstallBtn.click();
		await sleep(250);
		const confirm = page.locator(".ip-btn-danger", { hasText: /确认卸载|Confirm/ }).first();
		check("卸载走两步确认", (await confirm.count()) > 0);
		if (await confirm.count()) await confirm.click();
		let done = false;
		for (let i = 0; i < 100; i++) {
			done = jobFrames.some((f) => f.dir === "in" && f.s.includes('"phase":"done"') && f.s.includes('"ok":true'));
			if (done) break;
			await sleep(200);
		}
		const sentInstall = jobFrames.some((f) => f.dir === "out" && f.s.includes('"action":"uninstall"'));
		check("卸载走后台作业（客户端发 plugin_job，服务端回 done:ok）", sentInstall && done);
		check("设置面板全程没有关闭", (await page.locator(".settings-modal, .set-body").count()) > 0);
		let gone = false;
		for (let i = 0; i < 40; i++) {
			if ((await page.getByText("Top Test", { exact: false }).count()) === 0) {
				gone = true;
				break;
			}
			await sleep(200);
		}
		check("卸载结果可见（插件从列表消失）", gone);
	}

	check("页面没有 JS 报错", errors.filter((e) => !/favicon|net::ERR/.test(e)).length === 0);
	if (errors.length)
		console.log(
			"console errors:",
			errors.slice(0, 5).map((e) => e.slice(0, 200)),
		);
	passedChecks = passed;
	console.log(`\n${passed} checks passed`);
}

try {
	await main();
} catch (err) {
	console.error("test error:", err);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {}
	if (server?.pid) {
		try {
			process.kill(-server.pid, "SIGKILL");
		} catch {
			try {
				server.kill("SIGKILL");
			} catch {}
		}
	}
	rmSync(base, { recursive: true, force: true });
	await sleep(300);
	process.exit(process.exitCode ?? 0);
}
