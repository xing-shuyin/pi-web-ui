/**
 * image-toolkit 视图 E2E：把插件的 client/entry.mjs 挂进一个迷你 harness 页
 * （复刻主应用的 .plugin-view 容器与主题变量），用真实 Chrome 跑一遍：
 * 导入图片 → 参数面板各 tab → 裁剪选框 → 精确体积 → 导出下载 → 存回工作区。
 *
 * 工作区接口（/plugins-api/image-toolkit/ws/*）用 page.route 打桩，所以这个测试
 * 不需要起 pi-web-ui 服务端、不烧 token、不联网。
 *
 * Run: node tests/image-toolkit-view-test.mjs
 * 缺 Chrome（PI_WEB_CHROME 或常见路径都找不到）时自动 SKIP。
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { decodeImage, encodeImage } from "../plugins/image-toolkit/core/codec.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8913;

if (!CHROME_PATH || !existsSync(CHROME_PATH)) {
	console.log("SKIP：找不到 Chrome（设置 PI_WEB_CHROME 或装一个）");
	process.exit(0);
}

let failures = 0;
const ok = (m) => console.log(`✓ ${m}`);
const check = (cond, m) => {
	if (cond) ok(m);
	else {
		failures++;
		console.error(`✗ ${m}`);
	}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 夹具：400×300 渐变 PNG（带透明角），有内容才好看、也能验证透明处理。 */
async function fixture() {
	const w = 400;
	const h = 300;
	const data = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			data[i] = Math.round((x / w) * 255);
			data[i + 1] = Math.round((y / h) * 255);
			data[i + 2] = 180;
			data[i + 3] = x < 40 && y < 40 ? 0 : 255;
		}
	}
	return encodeImage({ width: w, height: h, data, hasAlpha: true, format: "png" }, "png");
}

const HARNESS = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>image-toolkit harness</title>
<style>
:root { --bg:#0d0e12; --bg-elev:#14161c; --bg-elev2:#1a1d26; --border:#262a35; --border-soft:#1e2230;
  --text:#e6e8ef; --text-dim:#9aa1b4; --text-faint:#6b7284; --accent:#8b5cf6; --accent-soft:rgba(139,92,246,.14);
  --green:#34d399; --green-soft:rgba(52,211,153,.12); --red:#f87171; --amber:#fbbf24;
  --sans: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
html, body { margin:0; height:100%; overflow:hidden; background:var(--bg); color:var(--text); font:13px/1.5 var(--sans); }
#app { position:absolute; inset:0; display:flex; flex-direction:column; }
#view { flex:1; min-height:0; display:flex; }
.plugin-view { flex:1; overflow:auto; min-width:0; }
</style></head>
<body><div id="app"><div id="view"><div class="plugin-view" id="mount"></div></div></div>
<script type="module">
  import entry from "/plugins/image-toolkit/client/entry.mjs";
  const sent = [];
  window.__sent = sent;
  entry.mount(document.getElementById("mount"), {
    pluginId: "image-toolkit",
    send: (p) => sent.push(p),
    onData: () => () => {},
  });
  window.__mounted = true;
</script></body></html>`;

const MIME = {
	".mjs": "text/javascript; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".json": "application/json",
};

const server = createServer((req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
	if (url.pathname === "/" || url.pathname === "/index.html") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(HARNESS);
		return;
	}
	const rel = normalize(url.pathname).replace(/^([/\\])+/, "");
	const file = resolve(ROOT, rel);
	if (!file.startsWith(resolve(ROOT))) {
		res.writeHead(403).end("no");
		return;
	}
	try {
		const body = readFileSync(file);
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
		res.end(body);
	} catch {
		res.writeHead(404).end("not found");
	}
});

let browser = null;
const tmp = mkdtempSync(join(tmpdir(), "igt-view-"));
try {
	const png = await fixture();
	writeFileSync(join(tmp, "photo.png"), png);
	await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

	browser = await chromium.launch({ executablePath: CHROME_PATH, args: ["--no-sandbox"] });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
	const errors = [];
	page.on("pageerror", (e) => {
		errors.push(String(e));
		console.error("PAGEERROR:", String(e).split(String.fromCharCode(10)).slice(0, 4).join(" | "));
	});
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(`console: ${m.text()}`);
	});

	// ---- 工作区接口打桩（不依赖真实服务端） --------------------------------
	const saved = [];
	await page.route("**/plugins-api/image-toolkit/ws/settings", (r) =>
		r.fulfill({
			json: {
				cwd: "E:/demo",
				settings: { defaultFormat: "keep", quality: 0.82, maxDim: 0, suffix: "-min", overwrite: false, aiTools: true },
				serverFormats: ["png", "jpeg", "bmp"],
			},
		}),
	);
	await page.route("**/plugins-api/image-toolkit/ws/list*", (r) =>
		r.fulfill({
			json: {
				cwd: "E:/demo",
				dir: "",
				entries: [
					{ name: "pics", type: "dir", path: "pics", isImage: false },
					{ name: "logo.png", type: "file", path: "logo.png", isImage: true },
					{ name: "readme.md", type: "file", path: "readme.md", isImage: false },
				],
			},
		}),
	);
	await page.route("**/plugins-api/image-toolkit/ws/image*", (r) => r.fulfill({ contentType: "image/png", body: png }));
	await page.route("**/plugins-api/image-toolkit/ws/save*", (r) => {
		saved.push(r.request().url());
		return r.fulfill({
			json: { ok: true, path: "out/photo-min.webp", pretty: "out/photo-min.webp", bytes: 1, renamed: false },
		});
	});

	await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
	await page.waitForSelector(".igt", { timeout: 15_000 });
	// 记录「没有任何人 preventDefault」的原生 dragstart：插件内部拖拽不该起原生拖图
	// （Chrome 会把 <canvas> 当图片拖，连带冒泡出主应用的全窗口拖放提示框）。
	await page.evaluate(() => {
		window.__dragStarts = 0;
		window.addEventListener("dragstart", (e) => {
			if (!e.defaultPrevented) window.__dragStarts++;
		});
	});

	// ---- 1. 外壳 ---------------------------------------------------------
	const tabs = await page.$$eval(".igt-tab", (els) => els.map((e) => e.textContent));
	check(tabs.length === 7, `7 个参数 tab（${tabs.join("/")}）`);
	check((await page.textContent(".igt-title"))?.includes("图片工具"), "标题渲染为中文");
	check((await page.textContent(".igt-placeholder"))?.includes("先导入"), "没有图片时给引导文案");

	// ---- 2. 导入图片 -----------------------------------------------------
	await page.setInputFiles(".igt input[type=file]", join(tmp, "photo.png"));
	await page.waitForSelector(".igt-qitem", { timeout: 15_000 });
	await sleep(600);
	const qsub = await page.textContent(".igt-qsub");
	check(/400×300/.test(qsub ?? ""), `队列项显示源尺寸（${qsub}）`);
	const canvas = await page.$eval(".igt-canvas", (c) => ({ w: c.width, h: c.height, css: c.style.width }));
	check(canvas.w > 0 && canvas.css !== "", `预览画布已渲染（${canvas.w}×${canvas.h}，CSS ${canvas.css}）`);
	const painted = await page.$eval(".igt-canvas", (c) => {
		const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
		let solid = 0;
		for (let i = 3; i < d.length; i += 4) if (d[i] > 8) solid++;
		return solid;
	});
	check(painted > 1000, `画布真的有像素（不透明像素 ${painted}）`);
	check((await page.textContent(".igt-statusbar"))?.includes("原始"), "状态条显示原始信息");
	const status0 = await page.textContent(".igt-statusbar");
	check(/输出 400×300/.test(status0 ?? ""), `状态条显示输出尺寸（${status0?.trim()}）`);

	// ---- 3. 参数面板：压缩 ------------------------------------------------
	await page.selectOption(".igt-ctl-select select", "webp");
	await sleep(500);
	const status1 = await page.textContent(".igt-statusbar");
	check(/WEBP/.test(status1 ?? ""), `切到 WebP 后状态条显示输出格式（${status1?.trim()}）`);
	check(!/PNG\b/.test(status1 ?? ""), "输出格式不再显示 PNG");
	const qualityHidden = await page.$$eval(".igt-ctl-range", (els) => els.length);
	check(qualityHidden >= 1, "WebP 下质量滑杆可见（有损格式）");
	await page.click(".igt-actions >> text=精确计算");
	// 精确值不带 ≈ 前缀：等它出现才算测到（旧的「≈ 估算」会立刻满足条件）
	await page.waitForFunction(
		() => {
			const tx = document.querySelector(".igt-statusbar")?.textContent ?? "";
			return /\d+(\.\d+)?\s?(KB|MB|B)/.test(tx) && !tx.includes("≈");
		},
		{ timeout: 30_000 },
	);
	const exact = await page.textContent(".igt-statusbar");
	check(/\d+(\.\d+)?\s?(KB|MB|B)/.test(exact ?? "") && !/≈/.test(exact ?? ""), `精确体积算出来了：${exact?.trim()}`);

	// ---- 4. 裁剪 tab ------------------------------------------------------
	await page.click('.igt-tab[data-tab="crop"]');
	await page.waitForSelector(".igt-crop-box", { timeout: 8000 });
	const handles = await page.$$eval(".igt-crop-h", (els) => els.length);
	check(handles === 8, `裁剪选框有 8 个把手（${handles}）`);
	let box = await page.$eval(".igt-crop-box", (el) => ({ w: el.style.width, h: el.style.height }));
	check(parseFloat(box.w) > 0 && parseFloat(box.h) > 0, `初始选框覆盖整图（${box.w}×${box.h}）`);
	await page.selectOption(".igt-ctl-select select", "1:1");
	await sleep(400);
	box = await page.$eval(".igt-crop-box", (el) => ({ w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
	check(Math.abs(box.w - box.h) <= 2, `锁定 1:1 后选框正方形（${box.w}×${box.h}）`);
	const ratioNums = await page.$$eval(".igt-ctl-num input", (els) => els.map((e) => Number(e.value)));
	check(
		ratioNums[2] === ratioNums[3] && ratioNums[2] === 300,
		`面板宽高跟锁比例一致（${ratioNums[2]}×${ratioNums[3]}）`,
	);
	// 拖右下角把手缩小选款 → 输出尺寸应随之变小
	const before = await page.textContent(".igt-stageinfo");
	const h8 = await page.$(".igt-crop-se");
	const hb = await h8.boundingBox();
	await page.mouse.move(hb.x + 5, hb.y + 5);
	await page.mouse.down();
	await page.mouse.move(hb.x - 120, hb.y - 120, { steps: 12 });
	await page.mouse.up();
	await sleep(500);
	const after = await page.textContent(".igt-stageinfo");
	check(before !== after, `拖动把手改变输出尺寸（${before} → ${after}）`);
	const cropNums = await page.$$eval(".igt-ctl-num input", (els) => els.map((e) => Number(e.value)));
	check(cropNums[2] > 0 && cropNums[2] < 400, `裁剪框宽高输入框同步（${cropNums.join("/")}）`);
	const paintedCropped = await page.$eval(".igt-canvas", (c) => {
		const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
		let solid = 0;
		for (let i = 3; i < d.length; i += 4) if (d[i] > 8) solid++;
		return solid;
	});
	check(paintedCropped > 500, "裁剪 tab 下仍画着未裁的全图（选框相对全图定位）");

	// ---- 5. 其它 tab -----------------------------------------------------
	await page.locator(".igt-btnrow button", { hasText: /^重置裁剪$/ }).click();
	await sleep(400);
	const resetNums = await page.$$eval(".igt-ctl-num input", (els) => els.map((e) => Number(e.value)));
	check(resetNums.join("/") === "0/0/400/300", `重置裁剪后选框回到全图（${resetNums.join("/")}）`);
	await page.click('.igt-tab[data-tab="resize"]');
	await sleep(150);
	await page.locator(".igt-btnrow button", { hasText: /^256$/ }).click();
	await sleep(400);
	const status3 = await page.textContent(".igt-statusbar");
	check(/输出 256×192/.test(status3 ?? ""), `按长边 256 后按比例缩放（${status3?.trim()}）`);

	await page.click('.igt-tab[data-tab="rotate"]');
	await page.click(".igt-btnrow >> text=右转 90°");
	await sleep(400);
	const status4 = await page.textContent(".igt-statusbar");
	check(/原始 400×300/.test(status4 ?? ""), "旋转后原始尺寸描述仍按源图报（不被旋转影响）");
	const stageInfo = await page.textContent(".igt-stageinfo");
	check(/^300×400 →/.test((stageInfo ?? "").trim()), `旋转 90° 后选框坐标系变成 300×400（${stageInfo}）`);

	await page.click('.igt-tab[data-tab="watermark"]');
	await page.waitForSelector(".igt-ctl-bool input[type=checkbox]", { timeout: 5000 });
	await page.click(".igt-ctl-bool input[type=checkbox]");
	await sleep(500);
	const wmInputs = await page.$$eval(".igt-panel-body .igt-input", (els) => els.length);
	check(wmInputs >= 4, `启用水印后出现水印控件（${wmInputs} 个输入）`);

	await page.click('.igt-tab[data-tab="filter"]');
	await sleep(200);
	const ranges = await page.$$eval('.igt-tab[data-tab="filter"]', () => 0);
	void ranges;
	// 拖一下亮度滑杆：非 100 值应触发重绘
	const bright = await page.$(".igt-ctl-range input[type=range]");
	const bb = await bright.boundingBox();
	await page.mouse.click(bb.x + bb.width * 0.75, bb.y + bb.height / 2);
	await sleep(500);
	const brightVal = await page.$eval(".igt-ctl-range .igt-ctl-val", (el) => el.textContent);
	check(Number(brightVal) > 100, `亮度滑杆生效（${brightVal}）`);

	// ---- 6. 信息 tab ------------------------------------------------------
	await page.click('.igt-tab[data-tab="info"]');
	await page.waitForSelector(".igt-hist", { timeout: 5000 });
	const infoText = await page.textContent(".igt-info");
	check(/400×300/.test(infoText ?? ""), "信息面板显示尺寸");
	check(/1\.2|0\.12|400/.test(infoText ?? "") && /主色调/.test(infoText ?? ""), "信息面板有宽高比与主色调");
	check((await page.$$eval(".igt-swatch", (e) => e.length)) > 0, "主色调色板有点击块");
	const exif = await page.textContent(".igt-info");
	check(/EXIF/.test(exif ?? ""), "信息面板有 EXIF 区（无 EXIF 时给说明）");

	// ---- 7. 导出下载 ------------------------------------------------------
	await page.click('.igt-tab[data-tab="compress"]');
	await sleep(200);
	const [download] = await Promise.all([
		page.waitForEvent("download", { timeout: 20_000 }),
		page.click(".igt-actions >> text=导出这张"),
	]);
	const dlPath = await download.path();
	const bytes = readFileSync(dlPath);
	const isWebp =
		bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
	check(isWebp, `下载文件是 WebP（${download.suggestedFilename()}，${bytes.length} B）`);
	check(
		/photo.*\.webp$/.test(download.suggestedFilename()),
		`文件名带后缀与正确扩展名（${download.suggestedFilename()}）`,
	);

	// ---- 8. 从工作区 ------------------------------------------------------
	await page.click(".igt-top >> text=从工作区");
	await page.waitForSelector(".igt-modal", { timeout: 8000 });
	await page.waitForSelector(".igt-wsitem", { timeout: 8000 });
	const wsItems = await page.$$eval(".igt-wsitem", (els) => els.map((e) => e.textContent.trim()));
	check(
		wsItems.some((t) => /pics/.test(t)) && wsItems.some((t) => /logo\.png/.test(t)),
		`工作区弹窗列出目录与图片（${wsItems.join(" | ")}）`,
	);
	check(!wsItems.some((t) => /readme/.test(t)), "非图片文件不在图片列表里");
	await page.click(".igt-wsitem >> text=logo.png");
	await page.waitForFunction(() => document.querySelectorAll(".igt-qitem").length === 2, { timeout: 15_000 });
	ok("从工作区选图 → 队列变成 2 张（走 /ws/image 拉取）");

	// ---- 9. 保存到工作区 --------------------------------------------------
	await page.click(".igt-actions >> text=保存到工作区");
	await page.waitForSelector(".igt-modal", { timeout: 8000 });
	const savePath = await page.$eval(".igt-modal input.igt-input", (el) => el.value);
	check(/photo-min\.webp$/.test(savePath), `保存路径默认带后缀与新扩展名（${savePath}）`);
	await page.evaluate(() => document.querySelectorAll(".igt-toast").forEach((n) => n.remove()));
	await page.click(".igt-modal-ft >> text=保存");
	await page.waitForFunction(() => (document.querySelector(".igt-toast")?.textContent ?? "").includes("已保存"), {
		timeout: 20_000,
	});
	check(saved.length === 1, `保存请求打到了 /ws/save（${saved[0]?.split("?")[1]}）`);
	const toast = await page.textContent(".igt-toast");
	check(/已保存到 out\/photo-min\.webp/.test(toast ?? ""), `保存成功提示（${toast?.trim()}）`);

	// ---- 10. 批量导出 ZIP -------------------------------------------------
	await page.click(".igt-actions >> text=导出全部（ZIP）");
	const [zip] = await Promise.all([
		page.waitForEvent("download", { timeout: 30_000 }),
		page.click(".igt-actions >> text=导出全部（ZIP）").catch(() => {}),
	]);
	const zipBytes = readFileSync(await zip.path());
	check(
		zipBytes.subarray(0, 2).toString("latin1") === "PK",
		`批量导出是真 ZIP（${zip.suggestedFilename()}，${zipBytes.length} B）`,
	);
	check(zipBytes.includes(Buffer.from("photo")), "ZIP 里含队列项文件名");

	// ---- 11. 裁剪形状：星形 → 导出 PNG 的四角必须是真透明 ----------------
	await page.click(".igt-qitem");
	await page.click(".igt-actions >> text=重置参数");
	await sleep(400);
	await page.click('.igt-tab[data-tab="crop"]');
	await sleep(300);
	const shapeSel = page.locator(".igt-ctl-select select").nth(1);
	check(
		(await page.$eval(".igt-ctl-select .igt-ctl-label", (e) => e.textContent)) === "比例",
		"裁剪 tab 第一个下拉是比例",
	);
	const shapeLabels = await page.$$eval(".igt-ctl-select", (els) =>
		els.map((e) => e.querySelector(".igt-ctl-label")?.textContent),
	);
	check(shapeLabels.includes("形状"), `裁剪 tab 有形状下拉（${shapeLabels.join("/")}）`);
	const shapeOpts = await shapeSel.locator("option").allTextContents();
	check(shapeOpts.length === 7 && shapeOpts.includes("星形"), `形状有 7 种：${shapeOpts.join("/")}`);
	check((await page.$$(".igt-ctl-range")).length === 0, "矩形时没有圆角半径滑杆");
	await shapeSel.selectOption("star");
	await sleep(500);
	const starPath = await page.$eval(".igt-crop-shape-line", (e) => e.getAttribute("d") ?? "");
	check(starPath.split("L").length === 10, `星形轮廓画了 10 个顶点（${starPath.slice(0, 40)}…）`);
	const svgVisible = await page.$eval(".igt-crop-svg", (e) => getComputedStyle(e).display !== "none");
	check(svgVisible, "星形时覆盖层显示形状轮廓");
	const dims = await page.$$eval(".igt-crop-dim", (els) => els.length);
	check(dims === 4, "框外遮罩是 4 块固定色块（不再是 9999px box-shadow）");
	await shapeSel.selectOption("rounded");
	await sleep(400);
	check((await page.$$(".igt-ctl-range")).length === 1, "切到圆角矩形后出现圆角半径滑杆");
	await shapeSel.selectOption("star");
	await sleep(400);
	const [dlShape] = await Promise.all([
		page.waitForEvent("download", { timeout: 20_000 }),
		page.click(".igt-actions >> text=导出这张"),
	]);
	const shapeOut = await decodeImage(readFileSync(await dlShape.path()));
	const alphaAt = (x, y) => shapeOut.data[(y * shapeOut.width + x) * 4 + 3];
	check(alphaAt(1, 1) === 0, `星形左下/左上角透明（角上 alpha=${alphaAt(1, 1)}）`);
	check(alphaAt(shapeOut.width - 2, 1) === 0, "星形右上角透明");
	check(alphaAt(shapeOut.width >> 1, shapeOut.height >> 1) === 255, "星形中心不透明（图还在）");
	check(alphaAt(shapeOut.width >> 1, 3) === 255, "星形正上方尖角处不透明");
	// 换成 JPEG（无 alpha）后，形状外应该被底色填满而不是透明
	await page.click('.igt-tab[data-tab="compress"]');
	await page.selectOption(".igt-ctl-select select", "jpeg");
	await sleep(400);
	const [dlJpeg] = await Promise.all([
		page.waitForEvent("download", { timeout: 20_000 }),
		page.click(".igt-actions >> text=导出这张"),
	]);
	const jpegBytes = readFileSync(await dlJpeg.path());
	check(jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8, "切成 JPEG 能正常导出（形状外由底色填）");
	await page.click('.igt-tab[data-tab="crop"]');
	await sleep(200);

	// ---- 11d. 自定义比例 W:H 与「按原图比例」 -----------------------------
	await page.click('.igt-tab[data-tab="crop"]');
	await sleep(300);
	const ratioSel = page.locator(".igt-ctl-select select").first();
	const ratioOpts = await ratioSel.locator("option").allTextContents();
	check(ratioOpts.at(-1) === "自定义", `比例下拉最后一项是自定义（${ratioOpts.join("/")}）`);
	await ratioSel.selectOption("custom");
	await sleep(400);
	const ratioFields = await page.$$eval(".igt-ctl-num", (els) =>
		els.map((e) => e.querySelector(".igt-ctl-label")?.textContent),
	);
	check(ratioFields[0] === "比例 宽" && ratioFields[1] === "比例 高", `出现自定义比例输入（${ratioFields.join("/")}）`);
	const rwInput = page.locator(".igt-ctl-num input").nth(0);
	const rhInput = page.locator(".igt-ctl-num input").nth(1);
	await rwInput.fill("21");
	await rwInput.dispatchEvent("change");
	await sleep(300);
	await rhInput.fill("9");
	await rhInput.dispatchEvent("change");
	await sleep(600);
	const wide = await page.$$eval(
		".igt-ctl-num input",
		(els) => els.slice(4, 6).map((e) => Number(e.value)) /* 自定义宽/高 占了 0,1：裁剪宽高在 4,5 */,
	);
	check(
		Math.abs(wide[0] / wide[1] - 21 / 9) < 0.05,
		`自定义 21:9 生效（选框 ${wide[0]}×${wide[1]}，比值 ${(wide[0] / wide[1]).toFixed(2)}）`,
	);
	const boxWide = await page.$eval(
		".igt-crop-box",
		(el) => el.getBoundingClientRect().width / el.getBoundingClientRect().height,
	);
	check(Math.abs(boxWide - 21 / 9) < 0.06, `选框形状跟着变（比值 ${boxWide.toFixed(2)}）`);
	// 「按原图比例」还原：比例字段变成当前图的宽高，选框回到整幅
	await page.locator(".igt-btnrow button", { hasText: /^按原图比例$/ }).click();
	await sleep(600);
	const back = await page.$$eval(".igt-ctl-num input", (els) => els.slice(0, 6).map((e) => Number(e.value)));
	check(back[0] === 400 && back[1] === 300, `按原图比例把比例字段设成图片尺寸（${back[0]}:${back[1]}）`);
	check(back[4] === 400 && back[5] === 300, `选框回到整幅（${back[4]}×${back[5]}）`);
	check((await ratioSel.inputValue()) === "custom", "还原后比例下拉处于自定义档");
	await ratioSel.selectOption("free");
	await sleep(300);

	// ---- 11c. 框内平移 / 框外拉新选区 / 不触发原生拖图 --------------------
	await page.locator(".igt-ctl-select select").first().selectOption("1:1");
	await sleep(400);
	// 先把框缩小：裁剪=全图时它占满整幅，本来就没有平移余地
	const cropNums2 = await page.$$(".igt-ctl-num input");
	await cropNums2[2].fill("120");
	await cropNums2[2].dispatchEvent("change");
	await sleep(500);
	const frameBox = await page.$eval(".igt-frame", (el) => {
		const b = el.getBoundingClientRect();
		return { x: b.x, y: b.y, w: b.width, h: b.height };
	});
	const boxRect = await page.$eval(".igt-crop-box", (el) => {
		const b = el.getBoundingClientRect();
		return { x: b.x, y: b.y, w: b.width, h: b.height };
	});
	check(
		Math.abs(boxRect.w - 120) <= 3 && Math.abs(boxRect.h - 120) <= 3,
		`锁 1:1 且宽=120 → 选框 120×120（${Math.round(boxRect.w)}×${Math.round(boxRect.h)}）`,
	);
	// ① 框内按住 → 平移选框
	await page.mouse.move(boxRect.x + boxRect.w / 2, boxRect.y + boxRect.h / 2);
	await page.mouse.down();
	await page.mouse.move(boxRect.x + boxRect.w / 2 + 60, boxRect.y + boxRect.h / 2 + 40, { steps: 12 });
	await page.mouse.up();
	await sleep(400);
	const movedTo = await page.$eval(
		".igt-crop-box",
		(el, fb) => {
			const b = el.getBoundingClientRect();
			return { x: Math.round(b.x - fb.x), y: Math.round(b.y - fb.y) };
		},
		frameBox,
	);
	check(
		Math.abs(movedTo.x - 60) <= 8 && Math.abs(movedTo.y - 40) <= 8,
		`框内按住能拖动选框（移到 ${movedTo.x},${movedTo.y}）`,
	);
	const panelXY = await page.$$eval(".igt-ctl-num input", (els) => els.slice(0, 2).map((e) => Number(e.value)));
	check(
		Math.abs(panelXY[0] - 60) <= 8 && Math.abs(panelXY[1] - 40) <= 8,
		`面板「左/上」跟着更新（${panelXY.join("/")}）`,
	);
	check(
		(await page.$eval(".igt-crop-move", (e) => getComputedStyle(e).cursor)) === "move",
		"框内有专门的平移命中区（cursor: move）",
	);
	// ② 框外（压暗区）按住 → 从落点拉出新选区
	await page.locator(".igt-ctl-select select").first().selectOption("free");
	await sleep(300);
	const sx = frameBox.x + frameBox.w - 20;
	const sy = frameBox.y + frameBox.h - 20;
	await page.mouse.move(sx, sy);
	await page.mouse.down();
	await page.mouse.move(sx - 160, sy - 120, { steps: 12 });
	await page.mouse.up();
	await sleep(400);
	const fresh = await page.$eval(
		".igt-crop-box",
		(el, fb) => {
			const b = el.getBoundingClientRect();
			return { x: Math.round(b.x - fb.x), y: Math.round(b.y - fb.y), w: Math.round(b.width), h: Math.round(b.height) };
		},
		frameBox,
	);
	check(Math.abs(fresh.w - 160) <= 10 && Math.abs(fresh.h - 120) <= 10, `框外拖拽拉出新选区（${fresh.w}×${fresh.h}）`);
	check(
		Math.abs(fresh.x - (frameBox.w - 20 - 160)) <= 10 && Math.abs(fresh.y - (frameBox.h - 20 - 120)) <= 10,
		`新选区从落点画起（左上角落在 ${fresh.x},${fresh.y}，起点应是 ${Math.round(frameBox.w - 180)},${Math.round(frameBox.h - 140)}）`,
	);
	// ③ 形状只影响导出：裁剪页预览里整张图必须还在（不然看着像「改形状把图改了」）
	await page.locator(".igt-ctl-select select").nth(1).selectOption("ellipse");
	await sleep(500);
	const tabCorner = await page.$eval(".igt-canvas", (c) => c.getContext("2d").getImageData(2, 2, 1, 1).data[3]);
	check(tabCorner > 200, `裁剪页预览里图片本身没被变形（角落 alpha=${tabCorner}）`);
	const ellipseD = await page.$eval(".igt-crop-shape-line", (e) => e.getAttribute("d") ?? "");
	check(ellipseD.includes("C"), `形状以轮廓呈现（椭圆路径已绘制）`);
	// 导出前把格式切回 PNG：形状的透明只有带 alpha 的格式才有意义（上一步刚切成 JPEG）
	await page.click('.igt-tab[data-tab="compress"]');
	await page.selectOption(".igt-ctl-select select", "png");
	await sleep(400);
	const [dlEllipse] = await Promise.all([
		page.waitForEvent("download", { timeout: 20_000 }),
		page.click(".igt-actions >> text=导出这张"),
	]);
	const ellipseOut = await decodeImage(readFileSync(await dlEllipse.path()));
	const ecorner = ellipseOut.data[(1 * ellipseOut.width + 1) * 4 + 3];
	const ecenter = ellipseOut.data[((ellipseOut.height >> 1) * ellipseOut.width + (ellipseOut.width >> 1)) * 4 + 3];
	check(ecorner === 0 && ecenter === 255, `导出结果才应用形状（椭圆外 alpha=${ecorner}、中心 ${ecenter}）`);
	await page.click('.igt-tab[data-tab="crop"]');
	await sleep(200);
	await page.locator(".igt-ctl-select select").nth(1).selectOption("rect");
	await sleep(300);

	// ---- 11e. 形状 + JPEG（无 alpha）→ 提示并自动/一键换成透明格式 --------
	// 造一张真 JPEG 源（浏览器自己编码），复现「JPEG 源 + 椭圆 → 白角」那个坑
	const jpegB64 = await page.evaluate(() => {
		const c = document.createElement("canvas");
		c.width = 320;
		c.height = 240;
		const x = c.getContext("2d");
		const g = x.createLinearGradient(0, 0, 320, 240);
		g.addColorStop(0, "#123a55");
		g.addColorStop(1, "#88aabb");
		x.fillStyle = g;
		x.fillRect(0, 0, 320, 240);
		return c.toDataURL("image/jpeg", 0.85).split(",")[1];
	});
	writeFileSync(join(tmp, "shot.jpg"), Buffer.from(jpegB64, "base64"));
	const beforeE = await page.$$eval(".igt-qitem", (els) => els.length);
	await page.setInputFiles(".igt input[type=file]", join(tmp, "shot.jpg"));
	await page.waitForFunction((n) => document.querySelectorAll(".igt-qitem").length === n + 1, beforeE, {
		timeout: 30_000,
	});
	await page.click(".igt-qitem:last-child");
	await sleep(800);
	await page.click('.igt-tab[data-tab="compress"]');
	await sleep(300);
	check(
		(await page.$eval(".igt-ctl-select select", (e) => e.value)) === "keep",
		"JPEG 源默认是「保持原格式」（= 输出也是 JPEG）",
	);
	// 选椭圆：应当自动把格式改成 PNG 并明确告知（而不是默默给一张白角图）
	await page.click('.igt-tab[data-tab="crop"]');
	await sleep(300);
	await page.locator(".igt-ctl-select select").nth(1).selectOption("ellipse");
	await sleep(700);
	const toasts1 = await page.$$eval(".igt-toast", (els) => els.map((e) => e.textContent).join(" | "));
	check(/改为 PNG/.test(toasts1), `自动切格式有明确提示（${toasts1.slice(0, 60)}…）`);
	await page.click('.igt-tab[data-tab="compress"]');
	await sleep(300);
	check((await page.$eval(".igt-ctl-select select", (e) => e.value)) === "png", "输出格式自动变成了 PNG");
	check(/形状外透明/.test((await page.textContent(".igt-statusbar")) ?? ""), "状态条标明「形状外透明」");
	// 显式切回 JPEG：不能再默默变白，必须给警告 + 一键按钮，状态条也要改口
	await page.selectOption(".igt-ctl-select select", "jpeg");
	await sleep(500);
	const warnTxt = await page.textContent(".igt-warn");
	check(/没有透明通道/.test(warnTxt ?? ""), `显式选 JPEG 时面板给警告（${(warnTxt ?? "").slice(0, 24)}…）`);
	check(/形状外填底色/.test((await page.textContent(".igt-statusbar")) ?? ""), "状态条改口为「形状外填底色」");
	const [dlWhite] = await Promise.all([
		page.waitForEvent("download", { timeout: 20_000 }),
		page.click(".igt-actions >> text=导出这张"),
	]);
	const whiteName = dlWhite.suggestedFilename();
	check(/\.jpg$/.test(whiteName), `此时导出的是 JPEG（${whiteName}）`);
	// 一键改回 PNG
	await page.locator(".igt-warn button").click();
	await sleep(500);
	check((await page.$eval(".igt-ctl-select select", (e) => e.value)) === "png", "点「改用 PNG」立刻切回透明格式");
	check((await page.$$(".igt-warn")).length === 0, "切回 PNG 后警告消失");
	const [dlAlpha] = await Promise.all([
		page.waitForEvent("download", { timeout: 20_000 }),
		page.click(".igt-actions >> text=导出这张"),
	]);
	const alphaOut = await decodeImage(readFileSync(await dlAlpha.path()));
	const acorner = alphaOut.data[(2 * alphaOut.width + 2) * 4 + 3];
	const acenter = alphaOut.data[((alphaOut.height >> 1) * alphaOut.width + (alphaOut.width >> 1)) * 4 + 3];
	check(acorner === 0 && acenter === 255, `换成 PNG 后角上真的透明了（角落 alpha=${acorner}、中心 ${acenter}）`);
	// 收拾现场：形状回矩形
	await page.click('.igt-tab[data-tab="crop"]');
	await sleep(200);
	await page.locator(".igt-ctl-select select").nth(1).selectOption("rect");
	await sleep(300);

	// ---- 11b. 大图拖动：跟手（不等画布重渲染）+ 不卡 --------------------
	const bigW = 3000;
	const bigH = 2000;
	const bigData = new Uint8Array(bigW * bigH * 4);
	for (let y = 0; y < bigH; y++) {
		for (let x = 0; x < bigW; x++) {
			const i = (y * bigW + x) * 4;
			bigData[i] = (x >> 3) & 0xff;
			bigData[i + 1] = (y >> 3) & 0xff;
			bigData[i + 2] = 120;
			bigData[i + 3] = 255;
		}
	}
	writeFileSync(
		join(tmp, "big.png"),
		await encodeImage({ width: bigW, height: bigH, data: bigData, hasAlpha: false, format: "png" }, "png"),
	);
	const beforeBigItem = await page.$$eval(".igt-qitem", (els) => els.length);
	await page.setInputFiles(".igt input[type=file]", join(tmp, "big.png"));
	await page.waitForFunction((n) => document.querySelectorAll(".igt-qitem").length === n + 1, beforeBigItem, {
		timeout: 30_000,
	});
	// 新加入队列的图不会自动选中（当前那张才是在编辑的），必须显式点它，
	// 否则下面拖的还是上一张 400×300 的小图，性能断言等于白测。
	await page.click(".igt-qitem:last-child");
	// 等覆盖层真的换成大图（只等「是百分比」会被上一张的 100% 骗过去）
	await page.waitForFunction(() => parseFloat(document.querySelector(".igt-crop-box")?.style.width ?? "0") > 600, {
		timeout: 30_000,
	});
	await sleep(300);
	const beforeBig = await page.$eval(".igt-crop-box", (el) => parseFloat(el.style.width));
	check(beforeBig > 600, `已切到 3000×2000 大图（选框宽 ${beforeBig}px，适应窗口）`);
	const stageScale = await page.$eval(".igt-zoom", (e) => e.textContent);
	check(
		/%$/.test(stageScale ?? "") && parseInt(stageScale, 10) < 100,
		`缩放比例显示为百分比且小于 100%（${stageScale}）`,
	);
	const seHandle = await page.$(".igt-crop-se");
	const hbBig = await seHandle.boundingBox();
	const t0 = Date.now();
	await page.mouse.move(hbBig.x + 5, hbBig.y + 5);
	await page.mouse.down();
	await page.mouse.move(hbBig.x - 160, hbBig.y - 160, { steps: 60 });
	// 关键断言：鼠标刚松开的那一刻（没给任何防抖/重渲染留时间）选框就必须已经跟上了
	const boxMid = await page.$eval(".igt-crop-box", (el) => parseFloat(el.style.width));
	await page.mouse.up();
	const dragMs = Date.now() - t0;
	check(boxMid < beforeBig - 20, `拖动过程中选框即时跟手（${beforeBig} → ${boxMid}，不等画布重渲染）`);
	check(dragMs < 3000, `3000×2000 大图 60 步拖动耗时 ${dragMs}ms（原实现每帧重渲染整幅图）`);
	await sleep(800);
	const canvasBig = await page.$eval(".igt-canvas", (c) => `${c.width}×${c.height}`);
	check(parseInt(canvasBig, 10) <= 900, `预览按显示需要渲染而不是整幅（画布 ${canvasBig}）`);
	// 顺手量一下「按显示需要渲染」省了多少（只打印，不断言：机器差异太大）
	const renderCost = await page.evaluate(async () => {
		const mod = await import("/plugins/image-toolkit/client/pipeline.mjs");
		const c = document.createElement("canvas");
		c.width = 3000;
		c.height = 2000;
		const cx = c.getContext("2d");
		const g = cx.createLinearGradient(0, 0, 3000, 2000);
		g.addColorStop(0, "#e11");
		g.addColorStop(1, "#16f");
		cx.fillStyle = g;
		cx.fillRect(0, 0, 3000, 2000);
		const bmp = await createImageBitmap(c);
		// 开到常用的滤镜档（gamma/锐化/暗角走逐像素，这是旧实现每帧重渲染时最贵的部分）
		const base = mod.defaultState({});
		const st = {
			...base,
			adjust: { ...base.adjust, brightness: 130, contrast: 110, gamma: 120, sharpen: 30, vignette: 40 },
		};
		const time = (scale) => {
			const t0 = performance.now();
			mod.renderToCanvas(bmp, st, { scale });
			return Math.round(performance.now() - t0);
		};
		time(0.232);
		return { need: time(0.232), cap: time(0.658), full: time(1) };
	});
	console.log(
		`    · 3000×2000 单次预览渲染：按显示需要(0.232) ${renderCost.need}ms · 旧预算上限(0.658) ${renderCost.cap}ms · 全分辨率 ${renderCost.full}ms`,
	);

	const afterBig = await page.$eval(".igt-crop-box", (el) => parseFloat(el.style.width));
	check(Math.abs(afterBig - boxMid) <= 2, "松手后选框停在拖到的位置（没被后续重渲染弹回）");

	// ---- 12. 撤销 / 语言 / 截图 -------------------------------------------
	await page.keyboard.press("Control+z");
	await sleep(300);
	ok("Ctrl+Z 撤销不报错");
	await page.click(".igt-top >> text=EN");
	await page.waitForFunction(() => document.querySelector(".igt-title")?.textContent?.includes("Image Toolkit"), {
		timeout: 8000,
	});
	ok("切语言后标题变英文（视图整体重建）");
	await page.click(".igt-top >> text=中文");
	await page.waitForFunction(() => document.querySelector(".igt-title")?.textContent?.includes("图片工具"), {
		timeout: 8000,
	});
	ok("切回中文正常");
	await page.click('.igt-tab[data-tab="crop"]');
	await page.click(".igt-qitem");
	await sleep(600);
	const shot = join(tmp, "shot-crop.png");
	await page.screenshot({ path: shot });
	await page.click('.igt-tab[data-tab="filter"]');
	await sleep(400);
	const shot2 = join(tmp, "shot-filter.png");
	await page.screenshot({ path: shot2 });
	console.log(`\n截图：\n  ${shot}\n  ${shot2}`);

	// 布局没被压扁：三个栏都应有实际宽度
	const layout = await page.evaluate(() => {
		const g = (s) => document.querySelector(s)?.getBoundingClientRect().width ?? 0;
		return {
			queue: g(".igt-queue"),
			stage: g(".igt-stage"),
			panel: g(".igt-panel"),
			h: document.querySelector(".igt")?.getBoundingClientRect().height ?? 0,
		};
	});
	check(
		layout.queue > 150 && layout.stage > 300 && layout.panel > 200,
		`三栏布局尺寸合理（${layout.queue}/${layout.stage}/${layout.panel}）`,
	);
	check(layout.h > 600, `视图占满高度（${layout.h}）`);

	const canvasDrag = await page.$eval(".igt-canvas", (c) => ({
		draggable: c.draggable,
		css: getComputedStyle(c).getPropertyValue("-webkit-user-drag").trim(),
	}));
	check(canvasDrag.draggable === false, "画布显式 draggable=false（Chrome 默认会把 canvas 当图片拖走）");
	check(canvasDrag.css === "none", `画布 CSS 也禁止原生拖拽（-webkit-user-drag: ${canvasDrag.css || "空"}）`);
	const naked = await page.evaluate(() => window.__dragStarts);
	check(naked === 0, `插件里的拖拽没有引发原生拖图/主应用拖放提示（未拦截的 dragstart=${naked}）`);
	const realErrors = errors.filter((e) => !/favicon|Clipboard|clipboard/i.test(e));
	check(realErrors.length === 0, `无 JS 报错${realErrors.length ? `：${realErrors.join(" | ")}` : ""}`);
} catch (err) {
	failures++;
	console.error(`✗ 测试异常：${err?.stack ?? err}`);
} finally {
	try {
		await browser?.close();
	} catch {
		/* 忽略 */
	}
	server.close();
	console.log(`\n临时目录（含截图）：${tmp}`);
}

if (failures) {
	console.error(`\n${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过 ✓");
}
