/**
 * 真实浏览器验收：en / zh / zh-TW 三个语言包各自渲染自己的文案。
 *
 * 断言用的字符串从词典本身推导（不手抄），覆盖两个刷新过的可见标签：
 *   deviceCenter: zh 设备中心 → zh-TW 裝置中心
 *   canvasTab:    zh 画布协同 → zh-TW 畫布協同
 * 因此 zh-TW 通过即证明 locales/zh-TW.json 被真正加载且已完成繁中转换。
 */
import assert from "node:assert/strict";
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

const zh = readJson("web/src/i18n/messages/core/zh.json");
const en = readJson("web/src/i18n/messages/core/en.json");
const zhTw = readJson("locales/zh-TW.json").strings;

const KEYS = ["deviceCenter", "canvasTab"];
// 禁词必须是「只有词典才会产生」的整句标签：已确认它们不出现在源码硬编码里，
// 因此正文里自带的简中提示句不会造成误报（body.innerText 含拆开的图标 + 文本，故用子串）。
const LOCALES = [
	{ code: "en", expect: KEYS.map((k) => en[k]), forbid: [zh.deviceCenter, zhTw.deviceCenter] },
	{ code: "zh", expect: KEYS.map((k) => zh[k]), forbid: [zhTw.deviceCenter] },
	// zh-TW 不做反向禁词：某些混合渲染面允许出现简中 key 文本，而「裝置中心/畫布協同」
	// 本身只可能来自已转换的繁中包，已足以区分语言（三个语系的期望文案互不相同）。
	{ code: "zh-TW", expect: KEYS.map((k) => zhTw[k]), forbid: [] },
];

if (!CHROME_PATH) {
	console.log("SKIP: Chrome unavailable");
	process.exit(0);
}
ensureBuild(root);

const port = 8989;
const dataDir = mkdtempSync(join(tmpdir(), "i18n-browser-test-"));
const log = openSync(join(dataDir, "server.log"), "a");
// 语言包装在 <dataDir>/locales（server/locales.ts 的 listPacks）：不装就只有内建 zh/en，
// zh-TW 会静静退回英文 —— 测试必须自己装包才能真的验到下载包加载路径。
mkdirSync(join(dataDir, "locales"), { recursive: true });
for (const code of ["zh-TW", "zh-Hant", "zh-HK"]) {
	copyFileSync(join(root, "locales", `${code}.json`), join(dataDir, "locales", `${code}.json`));
}
const server = spawn(process.execPath, ["dist/server/index.js", "--port", String(port), "--data-dir", dataDir], {
	cwd: root,
	env: {
		...process.env,
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_PORT: String(port),
		PI_WEB_DATA_DIR: dataDir,
		// 会话存于 <agentDir>/sessions：指到临时目录，否则会加载使用者真实对话，
		// 恢复的视图会盖住首屏标签，让断言变成随机失败。
		PI_CODING_AGENT_DIR: mkdtempSync(join(dataDir, "agent-")),
		PI_WEB_PLUGIN_CATALOG_URL: "off",
		PI_WEB_SDK: "bundled",
	},
	stdio: ["ignore", log, log],
	windowsHide: true,
});

let browser;
let failures = 0;
try {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (attempt === 99) throw new Error("i18n browser test server did not start");
	}

	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });

	for (const locale of LOCALES) {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await context.addInitScript((code) => {
			try {
				localStorage.setItem("pi-web-ui:lang", code);
			} catch {}
		}, locale.code);
		const page = await context.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
			// 等到该语言的主标签真的出现，而不是靠固定 sleep。
			await page.waitForFunction(
				(expected) => expected.every((text) => (document.body.innerText || "").includes(text)),
				locale.expect,
				{ timeout: 20_000 },
			);
			const seen = await page.evaluate(
				({ expected, forbid }) => {
					const text = (document.body.innerText || "").replace(/\s+/g, " ");
					return {
						missing: expected.filter((value) => !text.includes(value)),
						forbidden: forbid.filter((value) => text.includes(value)),
					};
				},
				{ expected: locale.expect, forbid: locale.forbid },
			);
			assert.deepEqual(seen.missing, [], `${locale.code}: 缺少预期文案 ${seen.missing.join(", ")}`);
			assert.deepEqual(seen.forbidden, [], `${locale.code}: 出现了不该出现的文案 ${seen.forbidden.join(", ")}`);
			assert.deepEqual(errors, [], `${locale.code}: 页面报错 ${errors.join(" | ")}`);
			console.log(`PASS ${locale.code.padEnd(6)} → ${locale.expect.map((t) => JSON.stringify(t)).join(", ")}`);
		} catch (error) {
			failures++;
			mkdirSync(join(root, ".artifacts/i18n"), { recursive: true });
			await page.screenshot({ path: join(root, `.artifacts/i18n/i18n-${locale.code}.png`) }).catch(() => {});
			console.error(`FAIL ${locale.code} → ${String(error instanceof Error ? error.message : error).slice(0, 400)}`);
		} finally {
			await context.close();
		}
	}
} finally {
	await browser?.close();
	// 先让服务端真的退出，再删临时目录：直接 rm 会撞上仍在写入的进程（ENOTEMPTY）。
	server.kill("SIGTERM");
	await new Promise((resolve) => {
		const done = setTimeout(resolve, 3000);
		server.once("exit", () => {
			clearTimeout(done);
			resolve();
		});
	});
	try {
		closeSync(log);
	} catch {}
	try {
		rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	} catch {
		// 临时目录清理失败不该让验收结果变成红灯；操作系统会回收 /tmp。
	}
}

if (failures > 0) {
	console.error(`\n${failures}/${LOCALES.length} locale(s) failed`);
	process.exit(1);
}
console.log(`\n✓ ${LOCALES.length}/${LOCALES.length} locales rendered their own language pack in a real browser`);
// 子进程/浏览器句柄可能仍存活，验收已完成后强制退出。
process.exit(0);
