import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

// Real installed runtime regression; no downloads, global build, or shared browser.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dataDir = process.env.PI_WEB_DATA_DIR || path.join(os.homedir(), ".pi-web");
const artifacts = [
	process.env.PI_WEB_OFFICE_ARTIFACTS,
	path.join(repoRoot, "plugins/office/artifacts"),
	path.join(dataDir, "plugins/office/artifacts"),
	path.join(dataDir, "plugins/office/node_modules/dsh-univer-office/artifacts"),
]
	.filter(Boolean)
	.find((p) => fs.existsSync(path.join(p, "gateway.cjs")) && fs.existsSync(path.join(p, "viewer/index.html")));
if (!CHROME_PATH || !artifacts) {
	console.log("SKIP office-canvas: Chrome or installed Office artifacts unavailable");
	process.exit(0);
}
const evidenceDir = path.join(repoRoot, ".tmp-verify-data");
fs.mkdirSync(evidenceDir, { recursive: true });
const screenshot = path.join(evidenceDir, "office-canvas.png"),
	reportPath = path.join(evidenceDir, "office-canvas-report.json");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "office-browser-smoke-"));
const plugin = path.join(base, "plugin"),
	workspace = path.join(base, "workspace");
fs.mkdirSync(workspace);
fs.cpSync(path.join(repoRoot, "plugins/office"), plugin, {
	recursive: true,
	filter: (p) => !p.includes("node_modules") && !p.includes("artifacts"),
});
fs.symlinkSync(artifacts, path.join(plugin, "artifacts"), "junction");
fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(plugin, "node_modules"), "junction");

const report = { base, started: new Date().toISOString(), errors: [], console: [], requests: [], rpc: [], host: [] };
const marker = "REMOTE_" + randomBytes(4).toString("hex");
report.marker = marker;
function zip(files) {
	let local = [],
		central = [],
		offset = 0;
	for (const [name, value] of Object.entries(files)) {
		const n = Buffer.from(name),
			d = Buffer.from(value);
		let crc = 0xffffffff;
		for (const b of d) {
			crc ^= b;
			for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		crc = (crc ^ 0xffffffff) >>> 0;
		let h = Buffer.alloc(30);
		h.writeUInt32LE(0x04034b50);
		h.writeUInt16LE(20, 4);
		h.writeUInt32LE(crc, 14);
		h.writeUInt32LE(d.length, 18);
		h.writeUInt32LE(d.length, 22);
		h.writeUInt16LE(n.length, 26);
		local.push(h, n, d);
		let c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50);
		c.writeUInt16LE(20, 4);
		c.writeUInt16LE(20, 6);
		c.writeUInt32LE(crc, 16);
		c.writeUInt32LE(d.length, 20);
		c.writeUInt32LE(d.length, 24);
		c.writeUInt16LE(n.length, 28);
		c.writeUInt32LE(offset, 42);
		central.push(c, n);
		offset += h.length + n.length + d.length;
	}
	let end = Buffer.alloc(22),
		cb = Buffer.concat(central);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(cb.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, cb, end]);
}
fs.writeFileSync(
	path.join(workspace, "smoke.xlsx"),
	zip({
		"[Content_Types].xml":
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
		"_rels/.rels":
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
		"xl/workbook.xml":
			'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="RemoteSmoke" sheetId="1" r:id="rId1"/></sheets></workbook>',
		"xl/_rels/workbook.xml.rels":
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
		"xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${marker}</t></is></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Broker Proof</t></is></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>`,
	}),
);
let server, browser, dispose;
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/client", express.static(path.join(plugin, "client")));
app.get("/canvas-broker.mjs", (_, res) => res.sendFile(path.join(plugin, "client/canvas-broker.mjs")));
const html = `<!doctype html><style>body{margin:0;font:14px Arial}header{padding:10px;background:#eee}iframe{width:100%;height:850px;border:0}</style><header id="status">Starting isolated remote Office canvas</header><iframe id="canvas"></iframe><script type="module">
import {attachCanvasBroker} from '/canvas-broker.mjs';window.smoke={ready:false,errors:[],rpc:[],events:[]};addEventListener('message',e=>{smoke.events.push({type:e.data?.type,origin:e.origin})});async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok||v.ok===false)throw Error(JSON.stringify(v));return v;}try{smoke.open=await api('/open?path=smoke.xlsx');const c=await api('/canvas-create',{path:'smoke.xlsx'});smoke.bytes=c.srcdoc.length;smoke.sandbox=c.sandbox;const iframe=document.querySelector('iframe');iframe.setAttribute('sandbox',c.sandbox);window.stopBroker=attachCanvasBroker({iframe,channel:c.channel,request:async(message,{signal})=>{const e={op:message.op,url:(message.url||message.path||'').replace(/sessionTicket=[^&]+/g,'sessionTicket=REDACTED')};smoke.rpc.push(e);const r=await fetch('/canvas-rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:c.token,message}),signal});const v=await r.json();e.status=r.status;e.error=v.error;if(!r.ok||!v.ok)throw Error(v.error);return v.result;},onReady(){smoke.ready=true;document.querySelector('#status').textContent='APP READY — broker connected'},onError(e){smoke.errors.push(e.message);document.querySelector('#status').textContent=e.message}});iframe.srcdoc=c.srcdoc;window.canvasToken=c.token;}catch(e){smoke.errors.push(e.stack);document.querySelector('#status').textContent=e.message;}</script>`;
app.get("/", (_, res) => res.type("html").send(html));
function save() {
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

try {
	const mod = await import(pathToFileURL(path.join(plugin, "index.mjs")));
	dispose = await mod.default.activate({
		cwd: workspace,
		route(method, url, handler) {
			app[method.toLowerCase()](url, handler);
		},
		log(...args) {
			report.host.push(args);
			console.log("HOST", ...args);
		},
		registerTool() {},
		fs: { glob: async () => [] },
	});
	server = await new Promise((resolve, reject) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
		s.on("error", reject);
	});
	let port = server.address().port;
	assert.ok(port >= 8900, "HTTP test port must be >=8900");
	report.port = port;
	report.chrome = CHROME_PATH;
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--disable-dev-shm-usage"] });
	const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
	await context.addInitScript(() => {
		window.__drawnTexts = [];
		window.__textPositions = [];
		const p = CanvasRenderingContext2D.prototype;
		for (const key of ["fillText", "strokeText"]) {
			const orig = p[key];
			p[key] = function (text, ...rest) {
				if (window.__drawnTexts.length < 20000) window.__drawnTexts.push(String(text));
				if (String(text).startsWith("REMOTE_")) {
					const rect = this.canvas.getBoundingClientRect(),
						m = this.getTransform();
					window.__textPositions.push({
						text: String(text),
						x: rect.x + ((m.a * rest[0] + m.c * rest[1] + m.e) * rect.width) / this.canvas.width,
						y: rect.y + ((m.b * rest[0] + m.d * rest[1] + m.f) * rect.height) / this.canvas.height,
					});
				}
				return orig.call(this, text, ...rest);
			};
		}
	});
	const page = await context.newPage();
	page.on("console", (m) => {
		if (["error", "warning"].includes(m.type())) report.console.push({ type: m.type(), text: m.text().slice(0, 2500) });
	});
	page.on("pageerror", (e) => {
		report.errors.push(e.stack);
		console.log("PAGEERROR", e.message);
	});
	page.on("request", (r) =>
		report.requests.push({ url: r.url().slice(0, 600), method: r.method(), type: r.resourceType() }),
	);
	page.on("requestfailed", (r) =>
		report.errors.push("REQUESTFAILED " + r.url().slice(0, 300) + " " + r.failure()?.errorText),
	);
	await page.goto("http://127.0.0.1:" + port, { waitUntil: "domcontentloaded" });
	try {
		await page.waitForFunction(() => window.smoke?.ready || window.smoke?.errors?.length, { timeout: 65000 });
	} catch (e) {
		report.readyTimeout = e.message;
	}
	await page.waitForTimeout(3000);
	const child = page.frames().find((f) => f.parentFrame());
	if (child && (await page.evaluate(() => window.smoke?.ready))) {
		try {
			await child.waitForFunction(
				() =>
					window.__drawnTexts?.some((t) => t.startsWith("REMOTE_")) ||
					document.body.innerText.includes("Failed to load"),
				{},
				{ timeout: 30000 },
			);
		} catch (e) {
			report.renderTimeout = e.message;
		}
	}
	report.inputs = child
		? await child.locator("input,textarea,[contenteditable=true]").evaluateAll((es) =>
				es.map((e) => ({
					tag: e.tagName,
					value: e.value,
					placeholder: e.getAttribute("placeholder"),
					class: e.className,
					aria: e.getAttribute("aria-label"),
				})),
			)
		: [];
	if (child) {
		const cell = await child.evaluate(
			() =>
				window.__textPositions?.find((t) => t.text.startsWith("REMOTE_") && t.x > 0 && t.y > 120) ?? {
					x: 65,
					y: 165,
					text: "A1 observed grid position",
				},
		);
		if (cell) {
			report.uiEdit = { cell, value: "BROWSER_EDIT_" + marker };
			await child.evaluate(({ x, y }) => {
				const e = document.elementFromPoint(x + 5, y - 5);
				window.__editTarget = e?.tagName;
			}, cell);
			const box = await page.locator("iframe").boundingBox();
			await page.mouse.dblclick(box.x + cell.x + 8, box.y + cell.y - 5);
			await page.keyboard.press("ControlOrMeta+A");
			await page.keyboard.type(report.uiEdit.value, { delay: 20 });
			await page.keyboard.press("Enter");
			await page.waitForTimeout(3000);
			report.uiEdit.drawn = await child.evaluate((v) => window.__drawnTexts.includes(v), report.uiEdit.value);
		}
	}
	report.parent = await page.evaluate(() => window.smoke);
	report.frames = [];
	for (const frame of page.frames()) {
		report.frames.push(
			await frame
				.evaluate(() => ({
					url: location.href,
					origin: self.origin,
					text: document.body.innerText.slice(0, 14000),
					canvases: [...document.querySelectorAll("canvas")].map((c) => ({
						width: c.width,
						height: c.height,
						rect: JSON.stringify(c.getBoundingClientRect()),
					})),
					drawn: window.__drawnTexts,
					security: {
						parentAccessible: (() => {
							try {
								return !!parent.document;
							} catch {
								return false;
							}
						})(),
					},
				}))
				.catch((e) => ({ error: e.message })),
		);
	}
	await page.screenshot({ path: screenshot, fullPage: true });
	report.external = report.requests.filter(
		(r) => /^https?:/.test(r.url) && !r.url.startsWith("http://127.0.0.1:" + port + "/"),
	);
	const api = async (url, body) => {
		const r = await fetch("http://127.0.0.1:" + port + url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: r.status, body: await r.json() };
	};
	report.read = await api("/read-sheet", { path: "smoke.xlsx", sheet: "RemoteSmoke", range: "A1:B2" });
	if (report.uiEdit) report.uiEdit.persisted = report.read.body?.result?.values?.[0]?.[0] === report.uiEdit.value;
	report.edit = await api("/edit", {
		path: "smoke.xlsx",
		sheet: "RemoteSmoke",
		range: "B2",
		values: [[99]],
		save: true,
	});
	report.readAfter = await api("/read-sheet", { path: "smoke.xlsx", sheet: "RemoteSmoke", range: "A1:B2" });
	report.save = await api("/save", { path: "smoke.xlsx", targetPath: "saved.xlsx" });
	report.savedExists = fs.existsSync(path.join(workspace, "saved.xlsx"));
	report.exportedRead = await api("/read-sheet", { path: "saved.xlsx", sheet: "RemoteSmoke", range: "A1:B2" });
	assert.equal(
		report.exportedRead.body?.result?.values?.[0]?.[0],
		report.uiEdit?.value,
		"Exported XLSX must preserve the browser edit",
	);
	assert.equal(
		String(report.exportedRead.body?.result?.values?.[1]?.[1]),
		"99",
		"Exported XLSX must preserve the server edit",
	);
	report.renderPass =
		!!report.parent?.ready &&
		report.frames.some((f) => f.canvases?.some((c) => c.width > 0)) &&
		report.frames.some((f) => f.drawn?.includes(marker)) &&
		report.external.length === 0;
	report.pass =
		report.renderPass &&
		report.uiEdit?.persisted === true &&
		report.errors.length === 0 &&
		!report.console.some((entry) => entry.type === "error") &&
		report.parent.errors.length === 0 &&
		report.frames.some((f) => f.origin === "null" && f.security?.parentAccessible === false);
	assert.ok(report.pass, "Opaque canvas render, keyboard edit, broker persistence, and network checks must pass");
	console.log(
		"RESULT",
		JSON.stringify({
			pass: report.pass,
			ready: report.parent?.ready,
			errors: report.errors,
			parentErrors: report.parent?.errors,
			rpcCount: report.parent?.rpc?.length,
			frames: report.frames.map((f) => ({
				origin: f.origin,
				text: f.text?.slice(0, 350),
				canvases: f.canvases?.length,
				marker: f.drawn?.includes(marker),
			})),
			base,
		}),
	);
} catch (e) {
	report.pass = false;
	report.errors.push(e.stack);
	console.error(e.stack);
} finally {
	await browser?.close().catch(() => {});
	dispose?.();
	if (server) {
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
	}
	await new Promise((r) => setTimeout(r, 1700));
	fs.rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
	report.cleaned = true;
	report.finished = new Date().toISOString();
	save();
	console.log("REPORT", reportPath);
	console.log("SCREENSHOT", screenshot);
	process.exitCode = report.pass ? 0 : 1;
}
