import { spawn } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../tests/lib/chrome.mjs";
import { freePort, portUp } from "../tests/lib/port-utils.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8960;
const SCREENSHOT_DIR = join(REPO, "test-screenshots");
const DATA_DIR = join(REPO, ".tmp-verify-data");

mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	console.log("=== 启动壁纸弹窗多主题实机测试与截图 ===");
	await freePort(PORT);

	mkdirSync(join(DATA_DIR, "plugins", "wallpaper-engine"), { recursive: true });
	cpSync(join(REPO, "plugins", "wallpaper-engine"), join(DATA_DIR, "plugins", "wallpaper-engine"), {
		recursive: true,
	});

	const env = {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_CWD: REPO,
		PI_WEB_DATA_DIR: DATA_DIR,
	};

	const srv = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		env,
		stdio: "ignore",
	});

	let up = false;
	for (let i = 0; i < 30; i++) {
		if (await portUp(PORT, "127.0.0.1", 500)) {
			up = true;
			break;
		}
		await sleep(500);
	}
	if (!up) {
		srv.kill();
		throw new Error("服务启动失败");
	}

	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
		args: ["--no-sandbox", "--disable-gpu-sandbox", "--enable-webgl"],
	});

	const context = await browser.newContext({
		viewport: { width: 1920, height: 1080 },
		deviceScaleFactor: 2.0,
	});

	const page = await context.newPage();

	try {
		await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
		await page.waitForFunction(() => Boolean(window.__piWallpaperEngineRuntime), { timeout: 15000 });

		console.log("1. 打开壁纸抽屉截取主题切换器...");
		await page.evaluate(() => {
			window.__piWallpaperEngineRuntime.drawer.open();
		});
		await sleep(1500);

		const shotDrawer = join(SCREENSHOT_DIR, "05-drawer-with-theme-selector.png");
		await page.screenshot({ path: shotDrawer });
		console.log(`✓ 已生成抽屉主题切换器截图: ${shotDrawer}`);

		console.log("2. 激活壁纸并设置示例消息...");
		await page.evaluate(async () => {
			const rt = window.__piWallpaperEngineRuntime;
			const res = await fetch("/plugins-api/wallpaper-engine/api/wallpapers");
			const json = await res.json();
			const w = json.wallpapers.find((item) => item.type === "scene" || item.hasScene) || json.wallpapers[0];
			if (w) {
				rt.state.activeId = w.id;
				void rt.bgLayer.setWallpaper(w, rt.state.settings);
			}

			const msgsWrap = document.querySelector(".messages");
			if (msgsWrap) {
				msgsWrap.innerHTML = `
					<div class="msg msg-user">
						<div class="msg-role">You</div>
						<div class="msg-body">
							<p>请帮我使用 WebGL2 和着色器实现一个动态流体粒子系统，并配合高对比度发光文本渲染！</p>
						</div>
					</div>
					<div class="msg msg-assistant">
						<div class="msg-role">Assistant</div>
						<div class="msg-body md">
							<p>已为你设计了<strong>极光微晶流体着色器（Aurora Micro-Crystal Shader）</strong>！我们在高分屏下启用了 <strong>1:1 原生物理像素渲染</strong> 与 <strong>MSAA 4x</strong> 抗锯齿，即使在强动态壁纸背景下，多层立体防眩光阴影也能保证文字极其清晰醒目：</p>
							<pre><code>// 片段着色器：极光流体微光模拟
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
out vec4 fragColor;

void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution) / min(u_resolution.x, u_resolution.y);
    float glow = 0.05 / abs(sin(uv.x * 3.0 + u_time) - uv.y);
    vec3 col = vec3(0.2, 0.7, 1.0) * glow;
    fragColor = vec4(col, 1.0);
}</code></pre>
							<p>所有工具面板、思维链与输入胶囊均已自动适配专属壁纸毛玻璃主题，享受极致沉浸式编程体验！</p>
						</div>
					</div>
				`;
			}
			const textarea = document.querySelector(".inputbox textarea");
			if (textarea) {
				textarea.value = "当前正在预览壁纸专属炫酷主题，文字与配色均已优化至最佳观感！";
			}
			rt.drawer.close();
		});
		await sleep(3500);

		console.log("3. 切换至【🔮 霓虹幻紫】主题...");
		await page.evaluate(() => {
			const select = document.querySelector("#pi-we-theme-select");
			if (select) {
				select.value = "synthwave";
				select.dispatchEvent(new Event("change"));
			}
		});
		await sleep(1500);
		const shotSynthwave = join(SCREENSHOT_DIR, "06-theme-synthwave.png");
		await page.screenshot({ path: shotSynthwave });
		console.log(`✓ 已生成霓虹幻紫主题截图: ${shotSynthwave}`);

		console.log("4. 切换至【🌑 黑曜冷月】主题...");
		await page.evaluate(() => {
			const select = document.querySelector("#pi-we-theme-select");
			if (select) {
				select.value = "obsidian";
				select.dispatchEvent(new Event("change"));
			}
		});
		await sleep(1500);
		const shotObsidian = join(SCREENSHOT_DIR, "07-theme-obsidian.png");
		await page.screenshot({ path: shotObsidian });
		console.log(`✓ 已生成黑曜冷月主题截图: ${shotObsidian}`);

		console.log("5. 切换至【🌲 极光翡翠】主题...");
		await page.evaluate(() => {
			const select = document.querySelector("#pi-we-theme-select");
			if (select) {
				select.value = "aurora";
				select.dispatchEvent(new Event("change"));
			}
		});
		await sleep(1500);
		const shotAurora = join(SCREENSHOT_DIR, "08-theme-aurora.png");
		await page.screenshot({ path: shotAurora });
		console.log(`✓ 已生成极光翡翠主题截图: ${shotAurora}`);

		console.log("6. 切换至【🌅 晚霞琥珀】主题...");
		await page.evaluate(() => {
			const select = document.querySelector("#pi-we-theme-select");
			if (select) {
				select.value = "amber";
				select.dispatchEvent(new Event("change"));
			}
		});
		await sleep(1500);
		const shotAmber = join(SCREENSHOT_DIR, "09-theme-amber.png");
		await page.screenshot({ path: shotAmber });
		console.log(`✓ 已生成晚霞琥珀主题截图: ${shotAmber}`);
	} finally {
		await browser.close();
		srv.kill();
		await freePort(PORT);
	}
	console.log("=== 全部多主题截图完成 ===");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
