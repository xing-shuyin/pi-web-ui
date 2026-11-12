import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const root = await mkdtemp(join(process.env.PI_TEST_TMP_DIR || tmpdir(), "pi-image-preview-"));
const artifactDir = process.env.PI_TEST_ARTIFACT_DIR || root;
const port = 8938;
const realOcr = process.env.PI_TEST_REAL_OCR === "1";
const entry = `
import React, {useState} from '${repo}/node_modules/react/index.js';
import {createRoot} from '${repo}/node_modules/react-dom/client.js';
import {ImageLightbox} from '${repo}/web/src/components/ImageLightbox.tsx';
import {LanguageProvider} from '${repo}/web/src/i18n.tsx';
import {registerImageOcrProvider, clearImageOcrProviders} from '${repo}/web/src/image-ocr-providers.ts';
import {registerImageOcrInstaller, setImageOcrInstallState} from '${repo}/web/src/image-ocr-install.ts';
import {fileToProcessedImage} from '${repo}/web/src/image-paste.ts';
import {registerAttachmentSink} from '${repo}/web/src/composer-bridge.ts';
import {registerImageLightboxHost} from '${repo}/web/src/image-lightbox-bridge.ts';
import {SystemScreenshotButton} from '${repo}/web/src/components/SystemScreenshotButton.tsx';
localStorage.setItem('pi-web-ui:lang','zh');
const sample=document.createElement('canvas');sample.width=1200;sample.height=720;
const ctx=sample.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1200,720);
ctx.fillStyle='#1e293b';ctx.font='bold 52px Arial';ctx.fillText('IMAGE OCR 2026',70,110);
ctx.font='36px "Microsoft YaHei", sans-serif';ctx.fillText('图片文字识别与需求标注',70,200);
ctx.font='30px Arial';ctx.fillText('Recognize text locally. No API key required.',70,285);
ctx.fillStyle='#edf3fb';ctx.fillRect(60,345,1080,255);
ctx.fillStyle='#334155';ctx.font='32px "Microsoft YaHei", sans-serif';
ctx.fillText('这里增加一个搜索框',90,410);ctx.fillText('用箭头、矩形和文字表达想法',90,480);
ctx.font='28px Arial';ctx.fillText('Search products, documents and ideas',90,550);
const original=sample.toDataURL();
window.originalSample=original;window.jpegSample=sample.toDataURL('image/jpeg');
window.installRequests=0;window.aborts=0;window.savedImage=null;window.attachedImages=[];
registerAttachmentSink(items=>window.attachedImages.push(...items));
// Exercise the actual download event without opening the OS file chooser.
window.showSaveFilePicker=undefined;
registerImageOcrInstaller(()=>{window.installRequests++;});
window.__piWebUiHost={imageOcrProviders:{register:registerImageOcrProvider}};
window.testApi={
failInstall:()=>setImageOcrInstallState(false,'模拟安装失败，请重试'),
registerMock:()=>{setImageOcrInstallState(false);registerImageOcrProvider({id:'mock',label:'Test OCR',recognize:({signal,onProgress})=>new Promise(resolve=>{signal.addEventListener('abort',()=>window.aborts++);onProgress(.4);window.finishOcr=()=>resolve({text:'IMAGE OCR 2026\\n图片文字识别'});})});},
clear:()=>clearImageOcrProviders(),
real:async()=>{clearImageOcrProviders();await import('/plugin/entry.mjs');},
preview:(src=original)=>window.openPreview(src),
switchConversation:()=>window.switchConversation(),
pauseImage:()=>{const fetchImage=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).startsWith('data:image/')){await new Promise(resolve=>window.resumeImage=()=>{window.fetch=fetchImage;resolve();});}return fetchImage(...args);};},
noComposer:()=>registerAttachmentSink(null),
};
function App(){const [open,setOpen]=useState(true);const [src,setSrc]=useState(original);const [editable,setEditable]=useState(true);const [session,setSession]=useState('conversation-1');window.reopen=()=>setOpen(true);window.changeImage=()=>setSrc(original+'#new');window.openPreview=(image)=>{setEditable(false);setSrc(image);setOpen(true);};window.switchConversation=()=>setSession('conversation-2');
registerImageLightboxHost({open:target=>window.openPreview(target.src),close:()=>setOpen(false)});
return <LanguageProvider><button id="reopen" onClick={()=>setOpen(true)}>预览图片</button><SystemScreenshotButton onNotice={(level,text)=>{window.screenshotNotice={level,text};}}/>{open&&<ImageLightbox src={src} alt="需求示意图.png" composerSessionId={session} onClose={()=>setOpen(false)} onSaveAnnotation={editable?async(dataUrl)=>{const blob=await(await fetch(dataUrl)).blob();const image=await fileToProcessedImage(new File([blob],'annotated.png',{type:'image/png'}));window.savedImage=image;setSrc('data:'+image.mimeType+';base64,'+image.data);}:undefined}/>}</LanguageProvider>}
createRoot(document.getElementById('root')).render(<App/>);
`;
await build({
	stdin: { contents: entry, resolveDir: repo, sourcefile: "image-preview-test.tsx", loader: "tsx" },
	bundle: true,
	loader: { ".css": "empty" },
	external: ["/plugin/*"],
	format: "esm",
	outfile: join(root, "app.js"),
	jsx: "automatic",
	define: { "process.env.NODE_ENV": '"development"' },
});
const server = createServer(async (req, res) => {
	try {
		const route = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
		if (route === "/") {
			res.setHeader("content-type", "text/html");
			res.end(
				'<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>图片预览 · OCR 与标注</title><link rel="stylesheet" href="/styles.css"><body style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
			);
			return;
		}
		if (route.startsWith("/api/")) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ packs: [], defaultLocale: "zh" }));
			return;
		}
		const paths = {
			"/app.js": join(root, "app.js"),
			"/styles.css": `${repo}/web/src/styles.css`,
			"/plugin/entry.mjs": `${repo}/plugins/image-ocr/client/entry.mjs`,
			"/plugin/worker.js": `${repo}/plugins/image-ocr/client/worker.js`,
		};
		if (!paths[route]) {
			res.writeHead(404).end();
			return;
		}
		res.setHeader("content-type", route.endsWith(".css") ? "text/css" : "text/javascript");
		res.end(await readFile(paths[route]));
	} catch (error) {
		res.writeHead(500).end(String(error));
	}
});
let browser;
try {
	await new Promise((ok, fail) => {
		server.once("error", fail);
		server.listen(port, "127.0.0.1", ok);
	});
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	const screenshotRequests = [];
	let screenshotGate = Promise.resolve();
	let finishScreenshot;
	let screenshotResult;
	await page.route("**/api/system-screenshot", async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill({ json: { available: true } });
			return;
		}
		screenshotRequests.push({ ...route.request().postDataJSON(), title: await page.title() });
		await screenshotGate;
		const json = screenshotResult ?? { dataUrl: await page.evaluate(() => window.originalSample) };
		screenshotResult = undefined;
		await route.fulfill({ json });
	});
	await page.goto(`http://127.0.0.1:${port}`);
	const ocr = page.getByRole("button", { name: "识别文字", exact: true });
	await ocr.waitFor();
	assert.equal(await ocr.isEnabled(), true);
	await ocr.click();
	await page.getByRole("button", { name: "正在安装或启用 OCR…", exact: true }).waitFor();
	assert.equal(await page.evaluate(() => window.installRequests), 1);
	await page.evaluate(() => window.testApi.failInstall());
	await page.getByRole("alert").filter({ hasText: "模拟安装失败" }).waitFor();
	await ocr.click();
	assert.equal(await page.evaluate(() => window.installRequests), 2);
	await page.evaluate(() => window.testApi.registerMock());
	await ocr.click();
	await page.getByRole("button", { name: "取消", exact: true }).click();
	assert.equal(await page.evaluate(() => window.aborts), 1);
	await page.evaluate(() => window.finishOcr());
	assert.equal(await page.locator("textarea").count(), 0);
	await ocr.click();
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	assert.equal(await page.evaluate(() => window.aborts), 2);
	await page.evaluate(() => window.finishOcr());
	await page.locator("#reopen").click();
	assert.equal(await page.locator("textarea").count(), 0);
	await ocr.click();
	await page.evaluate(() => window.finishOcr());
	assert.match(await page.getByRole("textbox", { name: "识别结果" }).inputValue(), /IMAGE OCR 2026/);
	await page.getByRole("button", { name: "复制纯文本", exact: true }).click();
	await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
	if (realOcr) {
		await page.evaluate(() => window.testApi.real());
		await ocr.click();
		await page.getByRole("textbox", { name: "识别结果" }).waitFor({ timeout: 120_000 });
		const text = await page.getByRole("textbox", { name: "识别结果" }).inputValue();
		assert.match(text, /IMAGE OCR 2026/);
		assert.match(text, /图\s*片/);
		console.log("Real local OCR passed:", text.replaceAll("\n", " | ").slice(0, 250));
	}
	await page.screenshot({ path: join(artifactDir, "image-preview-ocr.png") });
	await page.getByRole("button", { name: "标注图片", exact: true }).click();
	const canvas = page.locator(".image-annotation-canvas");
	await page.waitForFunction(() => document.querySelector(".image-annotation-canvas")?.width === 1200);
	const bounds = await canvas.boundingBox();
	assert.ok(bounds);
	const draw = async (x1, y1, x2, y2) => {
		await page.mouse.move(bounds.x + bounds.width * x1, bounds.y + bounds.height * y1);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width * x2, bounds.y + bounds.height * y2, { steps: 12 });
		await page.mouse.up();
	};
	await draw(0.65, 0.37, 0.45, 0.52);
	await page.getByRole("button", { name: "矩形", exact: true }).click();
	await draw(0.06, 0.45, 0.94, 0.84);
	await page.getByRole("button", { name: "画笔", exact: true }).click();
	await draw(0.1, 0.91, 0.5, 0.91);
	await page.getByRole("button", { name: "撤销", exact: true }).click();
	await page.getByRole("button", { name: "文字", exact: true }).click();
	await page.getByRole("textbox", { name: "文字", exact: true }).fill("这里增加搜索入口");
	await page.mouse.click(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.24);
	await page.screenshot({ path: join(artifactDir, "image-preview-annotation.png") });
	await page.getByRole("button", { name: "保存到附件", exact: true }).click();
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	const saved = await page.evaluate(() => window.savedImage);
	assert.ok(saved);
	assert.ok(saved.size < 2 * 1024 * 1024);
	const redPixels = await page.evaluate(async () => {
		const img = new Image();
		img.src = "data:" + window.savedImage.mimeType + ";base64," + window.savedImage.data;
		await img.decode();
		const c = document.createElement("canvas");
		c.width = img.width;
		c.height = img.height;
		const ctx = c.getContext("2d");
		ctx.drawImage(img, 0, 0);
		const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
		let count = 0;
		for (let i = 0; i < bytes.length; i += 4) if (bytes[i] > 180 && bytes[i + 1] < 120 && bytes[i + 2] < 120) count++;
		return count;
	});
	assert.ok(redPixels > 1000, `Annotation pixels were not saved: ${redPixels}`);
	const screenshot = page.getByRole("button", { name: "系统截图", exact: true });
	const screenshotMenu = page.getByRole("menu", { name: "系统截图", exact: true });
	const keepWindow = page.getByRole("menuitem", { name: "保留当前窗口截图", exact: true });
	const hideWindow = page.getByRole("menuitem", { name: "隐藏当前窗口截图", exact: true });
	const originalTitle = await page.title();
	// 点击本身就是「保留当前窗口截图」；悬停才展开唯一的「隐藏当前窗口截图」
	await screenshot.hover();
	await hideWindow.waitFor();
	assert.equal(await keepWindow.count(), 0);
	assert.equal(await screenshot.getAttribute("aria-expanded"), "true");
	assert.equal(screenshotRequests.length, 0);
	const menuBounds = await screenshotMenu.boundingBox();
	await page.screenshot({
		path: join(artifactDir, "screenshot-mode-menu.png"),
		clip: {
			x: 0,
			y: 0,
			width: Math.ceil(menuBounds.x + menuBounds.width + 16),
			height: Math.ceil(menuBounds.y + menuBounds.height + 16),
		},
	});
	await page.keyboard.press("Escape");
	await screenshotMenu.waitFor({ state: "hidden" });
	// 指针离开按钮，才会重新触发悬停
	await page.mouse.move(700, 800);
	await screenshot.hover();
	await hideWindow.waitFor();
	await page.mouse.move(700, 800);
	await screenshotMenu.waitFor({ state: "hidden" });
	assert.equal(screenshotRequests.length, 0);
	await screenshot.click();
	await page.getByRole("dialog").waitFor();
	assert.equal(screenshotRequests[0].hideWindow, false);
	assert.equal(screenshotRequests[0].title, originalTitle);
	assert.equal(await page.title(), originalTitle);
	await screenshotMenu.waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "关闭", exact: true }).click();
	screenshotResult = { cancelled: true };
	await screenshot.click();
	await page.waitForFunction(
		() => document.querySelector('[aria-label="系统截图"]').getAttribute("aria-busy") === "false",
	);
	assert.equal(await page.getByRole("dialog").count(), 0);
	assert.equal(await page.evaluate(() => window.screenshotNotice), undefined);
	screenshotGate = new Promise((resolve) => (finishScreenshot = resolve));
	await page.mouse.move(700, 800);
	await screenshot.hover();
	await hideWindow.click();
	await page.waitForFunction(() => document.title.includes("["));
	assert.equal(await screenshot.isDisabled(), true);
	await screenshotMenu.waitFor({ state: "hidden" });
	finishScreenshot();
	await page.getByRole("dialog").waitFor();
	assert.equal(screenshotRequests[2].hideWindow, true);
	assert.equal(screenshotRequests[2].title, `${originalTitle} [${screenshotRequests[2].token}]`);
	assert.equal(await page.title(), originalTitle);
	await page.getByRole("button", { name: "复制图片", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "图片已复制" }).waitFor();
	assert.equal(
		await page.evaluate(async () => (await navigator.clipboard.read())[0].types.includes("image/png")),
		true,
	);
	await page.getByRole("button", { name: "标注图片", exact: true }).click();
	await page.waitForFunction(() => document.querySelector(".image-annotation-canvas")?.width === 1200);
	const screenshotBounds = await canvas.boundingBox();
	await page.mouse.move(screenshotBounds.x + 40, screenshotBounds.y + 50);
	await page.mouse.down();
	await page.mouse.move(screenshotBounds.x + 220, screenshotBounds.y + 160, { steps: 10 });
	await page.mouse.up();
	await page.getByRole("button", { name: "保存标注", exact: true }).click();
	await page.getByRole("button", { name: "还原原图", exact: true }).waitFor();
	const editedSrc = await page.locator(".img-lightbox-image img").getAttribute("src");
	assert.notEqual(editedSrc, await page.evaluate(() => window.originalSample));
	await page.getByRole("button", { name: "复制图片", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "图片已复制" }).waitFor();
	const copiedBytes = await page.evaluate(async () => {
		const blob = await (await navigator.clipboard.read())[0].getType("image/png");
		return blob.size;
	});
	assert.ok(copiedBytes > 1000);
	const downloadEvent = page.waitForEvent("download");
	await page.getByRole("button", { name: "下载文件", exact: true }).click();
	const download = await downloadEvent;
	assert.equal(download.suggestedFilename(), "需求示意图.png");
	await download.saveAs(join(root, "annotated-screenshot.png"));
	const expectedDownload = await page.evaluate(
		async (src) => Array.from(new Uint8Array(await (await fetch(src)).arrayBuffer())),
		editedSrc,
	);
	assert.deepEqual(Array.from(await readFile(join(root, "annotated-screenshot.png"))), expectedDownload);
	await page.getByRole("button", { name: "附加到输入框", exact: true }).click();
	await page.getByRole("button", { name: "已附加到输入框", exact: true }).waitFor();
	const attachments = await page.evaluate(() => window.attachedImages);
	assert.equal(attachments.length, 1);
	assert.equal(attachments[0].imageData, editedSrc.split(",")[1]);
	assert.equal(attachments[0].mimeType, "image/png");
	assert.equal(attachments[0].path, "");
	assert.ok(attachments[0].size < 2 * 1024 * 1024);
	assert.equal(await page.getByRole("button", { name: "已附加到输入框", exact: true }).isDisabled(), true);
	await page.getByRole("button", { name: "放大", exact: true }).click();
	assert.equal(await page.locator(".img-lightbox-image-zoomed").count(), 1);
	await page.getByRole("button", { name: "适应窗口", exact: true }).click();
	assert.equal(await page.locator(".img-lightbox-image-zoomed").count(), 0);
	await page.screenshot({ path: join(artifactDir, "screenshot-preview-actions.png") });
	// 默认是小巧浮卡（不铺满），满屏靠按钮 / 双击 / F 键切；图标按钮不写文字，靠 data-tip 即时提示
	assert.equal(await page.locator(".img-lightbox").getAttribute("data-fullscreen"), null);
	const compactBox = await page.locator(".img-lightbox-panel").boundingBox();
	assert.ok(compactBox.width < 1200 && compactBox.height < 860, `默认预览不该铺满整屏：${Object.values(compactBox)}`);
	assert.equal(
		await page.evaluate(() => [...document.querySelectorAll(".img-lightbox-btn")].every((btn) => btn.dataset.tip)),
		true,
	);
	const isFullscreen = (value) =>
		value === true
			? document.querySelector(".img-lightbox")?.dataset.fullscreen === "true"
			: document.querySelector(".img-lightbox")?.dataset.fullscreen !== "true";
	await page.getByRole("button", { name: "全屏", exact: true }).click();
	await page.waitForFunction(isFullscreen, true);
	const fullBox = await page.locator(".img-lightbox-panel").boundingBox();
	assert.ok(fullBox.width > compactBox.width, "全屏后浮卡应当铺开");
	await page.screenshot({ path: join(artifactDir, "screenshot-preview-fullscreen.png") });
	await page.keyboard.press("Escape");
	await page.waitForFunction(isFullscreen, false);
	assert.equal(await page.getByRole("dialog").count(), 1, "Esc 先退出全屏，不直接关窗");
	await page.locator(".img-lightbox-image img").dblclick();
	await page.waitForFunction(isFullscreen, true);
	await page.getByRole("button", { name: "退出全屏", exact: true }).click();
	await page.waitForFunction(isFullscreen, false);
	await page.getByRole("button", { name: "还原原图", exact: true }).click();
	await page.waitForFunction(() => document.querySelector(".img-lightbox-image img")?.src === window.originalSample);
	await page.getByRole("button", { name: "标注图片", exact: true }).click();
	await page.keyboard.press("Escape");
	assert.equal(await page.locator(".image-annotation-editor").count(), 0);
	assert.equal(await page.getByRole("dialog").count(), 1);
	await page.evaluate(() => window.testApi.preview(window.jpegSample));
	await page.getByRole("button", { name: "复制图片", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "图片已复制" }).waitFor();
	assert.equal(
		await page.evaluate(async () => (await navigator.clipboard.read())[0].types.includes("image/png")),
		true,
	);
	await page.evaluate(() => window.testApi.pauseImage());
	await page.getByRole("button", { name: "附加到输入框", exact: true }).click();
	await page.waitForFunction(() => !!window.resumeImage);
	await page.evaluate(() => {
		window.testApi.switchConversation();
		window.resumeImage();
	});
	await page.getByRole("alert").filter({ hasText: "附加图片失败" }).waitFor();
	assert.equal(await page.evaluate(() => window.attachedImages.length), 1);
	await page.getByRole("button", { name: "复制图片", exact: true }).click();
	await page.getByRole("status").filter({ hasText: "图片已复制" }).waitFor();
	assert.equal(await page.getByRole("button", { name: "放大", exact: true }).isEnabled(), true);
	await page.evaluate(() => window.testApi.registerMock());
	await page.setViewportSize({ width: 390, height: 844 });
	await ocr.click();
	await page.evaluate(() => window.finishOcr());
	await page.getByRole("textbox", { name: "识别结果" }).waitFor();
	const overflows = await page.evaluate(
		() =>
			document.documentElement.scrollWidth > innerWidth ||
			document.querySelector(".img-lightbox").scrollWidth > innerWidth,
	);
	assert.equal(overflows, false);
	await page.screenshot({ path: join(artifactDir, "screenshot-preview-mobile.png") });
	assert.deepEqual(errors, []);
	console.log(
		"Shared preview UI passed: screenshot window modes, menu dismissal, cancellation, busy guard, OCR, annotation, original restore, clipboard PNG/JPEG, exact download bytes, draft attachment, conversation guard, zoom, mobile layout.",
	);
} finally {
	await browser?.close();
	await new Promise((ok) => server.close(ok));
	await rm(root, { recursive: true, force: true });
}
