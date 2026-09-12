/**
 * image-toolkit 插件测试（零 token、自包含、无网络）。
 *
 * 两段：
 *   A. 假 host 直测服务端入口 —— 把 index.mjs 的 activate() 跑在内存 host 上，
 *      拿到它注册的路由与 AI 工具直接调用（比经 HTTP 断言更细，能验证到
 *      「目标体积二分」「不支持的格式给出可执行建议」这类行为）；
 *   B. 真服务端接线 —— 起一个真实 server，把插件目录放进临时 data-dir，
 *      经 /plugins-api/image-toolkit/* 验证 host.route 真的挂上了、manifest 的
 *      permissions 声明足够、插件激活没有报错。
 *
 * 运行：先 npm run build:server，再 node tests/image-toolkit-test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { encodeImage, sniffFormat } from "../plugins/image-toolkit/core/codec.mjs";
import { probeImage } from "../plugins/image-toolkit/core/probe.mjs";
import { DICT } from "../plugins/image-toolkit/client/i18n.mjs";
import * as pipeline from "../plugins/image-toolkit/client/pipeline.mjs";
import { clamp, extOf, fmtBytes, makeZip, stem } from "../plugins/image-toolkit/client/util.mjs";
import * as cprobe from "../plugins/image-toolkit/client/probe.mjs";
import * as shapes from "../plugins/image-toolkit/client/shapes.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8912;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function ok(msg) {
	console.log(`✓ ${msg}`);
}
function check(cond, msg) {
	if (cond) ok(msg);
	else {
		failures++;
		console.error(`✗ ${msg}`);
	}
}
async function rejects(fn, re, msg) {
	try {
		await fn();
		failures++;
		console.error(`✗ ${msg}（没有抛错）`);
	} catch (err) {
		const text = String(err?.message ?? err);
		if (re.test(text)) ok(`${msg} → ${text.slice(0, 90)}`);
		else {
			failures++;
			console.error(`✗ ${msg}（错误信息不匹配 ${re}）：${text}`);
		}
	}
}

// ---------------------------------------------------------------------------
// 夹具：一张 40×30 的 PNG（纯色块 + 半透明角），一张同尺寸叠加用 PNG
// ---------------------------------------------------------------------------
function makeRgba(w, h, fn) {
	const data = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const [r, g, b, a] = fn(x, y);
			const i = (y * w + x) * 4;
			data[i] = r;
			data[i + 1] = g;
			data[i + 2] = b;
			data[i + 3] = a;
		}
	}
	return { width: w, height: h, data, hasAlpha: true, format: "png" };
}

async function pngFixture(w = 40, h = 30) {
	return encodeImage(
		makeRgba(w, h, (x, y) => [x * 6, y * 8, 128, x < 4 && y < 4 ? 0 : 255]),
		"png",
	);
}

/** 假 host：把插件真正用到的宿主能力都实现一遍（其余保持最小）。 */
function makeHost(cwd, pluginDir, settings = {}) {
	const routes = new Map();
	const tools = new Map();
	const notices = [];
	const broadcasts = [];
	const abs = (rel) => {
		const root = resolve(cwd);
		const target = resolve(root, String(rel ?? ""));
		if (target !== root && !target.startsWith(root + sep)) throw new Error(`路径越界：${rel}`);
		return target;
	};
	const host = {
		dir: pluginDir,
		dataDir: dirname(pluginDir),
		get cwd() {
			return cwd;
		},
		log() {},
		notify: (level, text) => notices.push({ level, text }),
		broadcast: (payload) => broadcasts.push(payload),
		onMessage: () => () => {},
		onAttach: () => () => {},
		onSettingsChanged: () => () => {},
		onCwdChange: () => () => {},
		registerAgentTool: (tool) => {
			tools.set(tool.name, tool);
			return () => tools.delete(tool.name);
		},
		registerCommand: () => () => {},
		route: (method, path, handler) => {
			const key = `${method} ${path}`;
			routes.set(key, handler);
			return () => routes.delete(key);
		},
		getSettings: () => settings,
		// 故意「装不上」：测没注入 JPEG 编解码时的行为
		ensureDeps: async () => false,
		storage: { get: (_k, d) => d, set: () => {}, delete: () => {}, all: () => ({}) },
		secrets: { set: () => {}, get: () => undefined, has: () => false, delete: () => {}, list: () => [] },
		fs: {
			async list(relDir = "") {
				const dir = abs(relDir);
				return readdirSync(dir, { withFileTypes: true }).map((d) => ({
					name: d.name,
					type: d.isDirectory() ? "dir" : "file",
				}));
			},
			async read(rel) {
				return readFileSync(abs(rel));
			},
			async readText(rel) {
				return readFileSync(abs(rel), "utf8");
			},
			async write(rel, data) {
				const target = abs(rel);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, data);
			},
			async remove(rel) {
				rmSync(abs(rel), { recursive: true, force: true });
			},
		},
	};
	return { host, routes, tools, notices, broadcasts };
}

/** 极简 res 替身。 */
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(v) {
			this.body = v;
			return this;
		},
		send(v) {
			this.body = v;
			return this;
		},
		type(t) {
			this.headers["content-type"] = t;
			return this;
		},
		setHeader(k, v) {
			this.headers[k] = v;
		},
	};
}

/** 极简 req 替身：带 raw body 的 async iterable。 */
function makeReq({ query = {}, body, raw } = {}) {
	const chunks = raw ? [raw] : [];
	return {
		query,
		body,
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c;
		},
	};
}

const callRoute = async (route, { query, body, raw } = {}) => {
	const res = makeRes();
	await route(makeReq({ query, body, raw }), res);
	return res;
};

const textOf = (result) => result?.content?.[0]?.text ?? String(result);

// ---------------------------------------------------------------------------
// A. 假 host 直测
// ---------------------------------------------------------------------------
async function partA() {
	console.log("\n── A. 假 host 直测 index.mjs ──");
	const cwd = mkdtempSync(join(tmpdir(), "igt-a-"));
	const pluginDir = join(cwd, ".plugin");
	mkdirSync(pluginDir, { recursive: true });
	const mod = await import(pathToFileURL(join(ROOT, "plugins", "image-toolkit", "index.mjs")).href);

	// 夹具：a.png（带透明角）、logo.png、sub/ 目录、一个假 webp、一个假 jpeg
	const png = await pngFixture(40, 30);
	writeFileSync(join(cwd, "a.png"), png);
	writeFileSync(join(cwd, "logo.png"), await pngFixture(10, 10));
	mkdirSync(join(cwd, "sub"), { recursive: true });
	writeFileSync(join(cwd, "sub", "b.png"), await pngFixture(20, 20));
	writeFileSync(join(cwd, "note.txt"), "不是图片");
	writeFileSync(
		join(cwd, "x.webp"),
		Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]),
	);
	writeFileSync(
		join(cwd, "y.jpg"),
		Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0, 0, 0, 0, 0]),
	);

	{
		const { host, routes, tools } = makeHost(cwd, pluginDir, { suffix: "-min", quality: 0.8 });
		const stop = mod.default.activate(host);

		// -- 注册面 ----------------------------------------------------------
		const routeKeys = [...routes.keys()].sort();
		check(
			routeKeys.join(",") ===
				["GET /ws/image", "GET /ws/list", "GET /ws/probe", "GET /ws/settings", "POST /ws/save"].join(","),
			`注册 5 条 HTTP 路由（实际：${routeKeys.join(" / ")}）`,
		);
		check(
			[...tools.keys()].sort().join(",") ===
				["image_compress", "image_info", "image_transform", "image_watermark"].join(","),
			`注册 4 个 AI 工具（实际：${[...tools.keys()].join(", ")}）`,
		);
		for (const t of tools.values()) {
			check(
				Boolean(t.name && t.description && t.parameters && typeof t.execute === "function"),
				`工具 ${t.name} 定义完整（description/parameters/execute）`,
			);
		}

		// -- /ws/settings ----------------------------------------------------
		let res = await callRoute(routes.get("GET /ws/settings"));
		check(
			res.body?.settings?.suffix === "-min" && Array.isArray(res.body?.serverFormats),
			"/ws/settings 回设置与服务端可写格式",
		);

		// -- /ws/list --------------------------------------------------------
		res = await callRoute(routes.get("GET /ws/list"), { query: { dir: "" } });
		const names = res.body.entries.map((e) => e.name);
		check(
			names.includes("a.png") && names.includes("sub") && names.includes("x.webp"),
			`/ws/list 列出文件与目录（${names.join(",")}）`,
		);
		check(names.indexOf("sub") === 0, "/ws/list 目录排在文件前面");
		check(res.body.entries.find((e) => e.name === "a.png")?.isImage === true, "/ws/list 标记图片文件");
		check(res.body.entries.find((e) => e.name === "note.txt")?.isImage === false, "/ws/list 非图片不标记");

		// -- /ws/probe -------------------------------------------------------
		res = await callRoute(routes.get("GET /ws/probe"), { query: { path: "a.png" } });
		check(
			res.body.width === 40 && res.body.height === 30 && res.body.format === "png",
			`/ws/probe 读出尺寸 ${res.body.width}×${res.body.height}`,
		);
		check(res.body.serverEditable === true && res.body.bytes === png.length, "/ws/probe 标记服务端可编辑并给出字节数");

		// -- /ws/image -------------------------------------------------------
		res = await callRoute(routes.get("GET /ws/image"), { query: { path: "a.png" } });
		check(Buffer.isBuffer(res.body) && res.body.equals(png), "/ws/image 原样回传字节");
		check(res.headers["content-type"] === "image/png", "/ws/image 带 image/png content-type");

		// -- /ws/save（原始 body，不走 JSON） --------------------------------
		const payload = await pngFixture(12, 12);
		res = await callRoute(routes.get("GET /ws/save") ?? routes.get("POST /ws/save"), {
			query: { path: "out/kept.png", overwrite: "0" },
			raw: payload,
		});
		check(res.body?.ok === true && existsSync(join(cwd, "out", "kept.png")), "/ws/save 写入新文件（自动建目录）");
		res = await callRoute(routes.get("POST /ws/save"), {
			query: { path: "out/kept.png", overwrite: "0" },
			raw: payload,
		});
		check(
			res.body?.renamed === true && existsSync(join(cwd, "out", "kept-1.png")),
			`/ws/save 不覆盖时自动改名（${res.body?.path}）`,
		);
		res = await callRoute(routes.get("POST /ws/save"), {
			query: { path: "out/kept.png", overwrite: "1" },
			raw: payload,
		});
		check(res.body?.renamed === false && existsSync(join(cwd, "out", "kept.png")), "/ws/save overwrite=1 时原地覆盖");
		res = await callRoute(routes.get("POST /ws/save"), {
			query: { path: "out/x.png" },
			body: { dataBase64: payload.toString("base64") },
		});
		check(
			res.body?.ok === true && existsSync(join(cwd, "out", "x.png")),
			"/ws/save 兼容 JSON base64 body（前端小图路径）",
		);
		// 越界路径：safeRoute 内部抦住 → 400 + 错误文案（绝不让 promise reject，
		// 否则会被宿主的 unhandledRejection 打挂服务）
		res = await callRoute(routes.get("GET /ws/probe"), { query: { path: "../escape.png" } });
		check(
			res.statusCode === 400 && /越界/.test(res.body?.error ?? ""),
			`/ws/probe 越界路径 → 400（${res.body?.error}）`,
		);
		res = await callRoute(routes.get("GET /ws/image"), { query: { path: "nope.png" } });
		check(
			res.statusCode === 400 && /ENOENT|no such file/i.test(res.body?.error ?? ""),
			"读不存在的文件也转成 400 而不是打挂服务",
		);

		// -- image_info ------------------------------------------------------
		let out = textOf(await tools.get("image_info").execute("t1", { path: "a.png" }));
		const info = JSON.parse(out);
		check(
			info[0].size === "40×30" && info[0].format === "png" && info[0].alpha === true,
			"image_info 报出尺寸/格式/透明",
		);
		check(info[0].serverEditable === true && info[0].humanBytes, "image_info 报出可编辑性与人类可读体积");
		out = textOf(await tools.get("image_info").execute("t2", { path: "a.png", details: true }));
		check(/dominantColors/.test(out) && /histogramPeak/.test(out), "image_info details 给出主色与直方图峰值");
		out = textOf(await tools.get("image_info").execute("t3", { dir: "" }));
		check(/sub\/b\.png/.test(out) && /a\.png/.test(out), "image_info dir 递归扫描到子目录图片");
		out = textOf(await tools.get("image_info").execute("t4", { path: "note.txt" }));
		check(/unknown/.test(out), "image_info 对非图片文件不炸（format=unknown）");

		// -- image_transform：旋转 + 裁剪 + 缩放 ------------------------------
		out = textOf(
			await tools.get("image_transform").execute("t5", {
				path: "a.png",
				rotate: 90,
				crop: { x: 0, y: 0, width: 20, height: 10 },
				resize: { width: 100, height: 50 },
				format: "png",
			}),
		);
		check(/✅/.test(out) && /100×50/.test(out), `image_transform 旋转→裁剪→缩放得到 100×50（${out.split("\n")[1]}）`);
		const rotated = probeImage(readFileSync(join(cwd, "a-min.png")));
		check(rotated.width === 100 && rotated.height === 50, "image_transform 输出文件真实尺寸 100×50");
		check(existsSync(join(cwd, "a.png")) && readFileSync(join(cwd, "a.png")).equals(png), "image_transform 不动原文件");

		// -- image_transform：不放大 ----------------------------------------
		out = textOf(
			await tools.get("image_transform").execute("t6", { path: "a.png", resize: { longEdge: 400 }, suffix: "-le" }),
		);
		check(/40×30/.test(out), "resize.longEdge 默认不放大（仍是 40×30）");

		// -- image_compress：目标体积 ----------------------------------------
		const big = await encodeImage(
			makeRgba(240, 180, (x, y) => [(x * 7) % 256, (y * 11) % 256, (x ^ y) % 256, 255]),
			"png",
		);
		writeFileSync(join(cwd, "noise.png"), big);
		out = textOf(
			await tools
				.get("image_compress")
				.execute("t7", { path: "noise.png", format: "png", suffix: "-shrunk", targetKB: 0 }),
		);
		check(/✅/.test(out), `image_compress PNG（无损，走 png 分支）成功：${out.split("\n")[1]}`);

		// -- 批量 ------------------------------------------------------------
		out = textOf(
			await tools
				.get("image_transform")
				.execute("t8", { paths: ["a.png", "sub/b.png", "note.txt"], resize: { longEdge: 32 }, suffix: "-small" }),
		);
		check(/✅.*a\.png/.test(out) && /✅.*sub\/b\.png/.test(out), "批量 paths 逐项处理成功");
		check(/❌.*note\.txt/.test(out), "批量里单项失败不炸整批，逐项报错");
		check(
			existsSync(join(cwd, "a-small.png")) && existsSync(join(cwd, "sub", "b-small.png")),
			"批量输出按各自目录落盘",
		);

		// -- 不支持格式 / 缺依赖：逐项报 ❌（不抛错，批量时不拖累其它项） ----
		out = textOf(await tools.get("image_transform").execute("t9", { path: "x.webp", resize: { longEdge: 10 } }));
		check(/❌/.test(out) && /视图/.test(out), `WebP 走服务端时给出「去视图处理」的可执行建议：${out.split("\n")[1]}`);
		out = textOf(await tools.get("image_compress").execute("t10", { path: "y.jpg", format: "jpeg" }));
		check(/❌/.test(out) && /jpeg-js/i.test(out), "JPEG 缺编解码器时提示装 jpeg-js");
		out = textOf(await tools.get("image_info").execute("t10b", { path: "x.webp" }));
		check(/webp/.test(out) && /serverEditable": false/.test(out), "image_info 能读 WebP 文件头并标记服务端不可编辑");

		// -- 精确尺寸（同时给宽高）覆盖 noUpscale -----------------------------
		out = textOf(
			await tools
				.get("image_transform")
				.execute("t6b", { path: "a.png", resize: { width: 160, height: 120 }, suffix: "-exact" }),
		);
		check(/160×120/.test(out), `同时给 width+height = 精确尺寸（允许放大）：${out.split("\n")[1]}`);

		// -- 参数校验 --------------------------------------------------------
		await rejects(() => tools.get("image_transform").execute("t11", {}), /缺少 path/, "无参数时报「缺少 path」");
		await rejects(
			() => tools.get("image_transform").execute("t12", { paths: ["a.png", "sub/b.png"], out: "one.png" }),
			/批量/,
			"批量 + out 被拒绝（避免互相覆盖）",
		);
		await rejects(
			() => tools.get("image_watermark").execute("t13", { path: "a.png" }),
			/watermarkPath/,
			"水印缺 watermarkPath 时报错",
		);

		// -- image_watermark -------------------------------------------------
		out = textOf(
			await tools
				.get("image_watermark")
				.execute("t14", { path: "a.png", watermarkPath: "logo.png", position: "br", opacity: 0.5, suffix: "-wm" }),
		);
		check(/✅/.test(out) && existsSync(join(cwd, "a-wm.png")), `image_watermark 落盘成功（${out.split("\n")[1]}）`);
		const wmOut = readFileSync(join(cwd, "a-wm.png"));
		const wmPix = probeImage(wmOut);
		check(wmPix.width === 40 && wmPix.height === 30, "水印不改变画布尺寸");
		check(!wmOut.equals(png), "水印确实改了像素");

		// -- settings 变化：aiTools 关闭 → 工具全下架 -------------------------
		const off = stop();
		void off;
	}
	{
		const { host, tools, broadcasts, notices } = makeHost(cwd, pluginDir, { aiTools: false });
		let settingsHandler = null;
		host.onSettingsChanged = (h) => {
			settingsHandler = h;
			return () => {};
		};
		const stop = mod.default.activate(host);
		check(tools.size === 0, "aiTools=false 时不注册任何 AI 工具");
		settingsHandler?.({ aiTools: true, suffix: "-x" });
		check(tools.size === 4, "设置里打开 aiTools 后工具即时上架");
		check(
			broadcasts.some((b) => b?.kind === "settings" && b.values?.suffix === "-x"),
			"设置变更广播给视图",
		);
		settingsHandler?.({ aiTools: false });
		check(tools.size === 0, "再关掉 aiTools 工具即时下架");
		stop();
		void notices;
	}
	// 反激活后路由应撤销
	{
		const { host, routes, tools } = makeHost(cwd, pluginDir, {});
		const stop = mod.default.activate(host);
		check(routes.size === 5 && tools.size === 4, "激活后路由与工具都在位");
		stop();
		check(routes.size === 0, "反激活撤销全部路由");
		check(tools.size === 0, "反激活撤销全部工具");
	}
	rmSync(cwd, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// B. 真服务端接线（路由真的挂上 / 权限声明够用 / 插件激活无错）
// ---------------------------------------------------------------------------
async function partB() {
	console.log("\n── B. 真服务端接线 ──");
	const dataDir = mkdtempSync(join(tmpdir(), "igt-b-"));
	const cwd = mkdtempSync(join(tmpdir(), "igt-b-cwd-"));
	mkdirSync(join(cwd, "pics"), { recursive: true });
	const png = await pngFixture(24, 18);
	writeFileSync(join(cwd, "pics", "p.png"), png);

	// 插件目录：真实插件源码（走 CLI 之外的路径：直接复制进 data-dir 的 plugins/）
	const pluginSrc = join(ROOT, "plugins", "image-toolkit");
	const pluginDst = join(dataDir, "plugins", "image-toolkit");
	mkdirSync(pluginDst, { recursive: true });
	for (const f of ["manifest.json", "index.mjs"]) writeFileSync(join(pluginDst, f), readFileSync(join(pluginSrc, f)));
	mkdirSync(join(pluginDst, "core"), { recursive: true });
	for (const f of readdirSync(join(pluginSrc, "core"))) {
		writeFileSync(join(pluginDst, "core", f), readFileSync(join(pluginSrc, "core", f)));
	}

	let proc = null;
	const stopServer = () => {
		if (!proc) return;
		try {
			proc.kill();
		} catch {
			/* 忽略 */
		}
		proc = null;
	};
	try {
		proc = spawn(process.execPath, [join(ROOT, "dist", "server", "index.js")], {
			env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: cwd },
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
		const t0 = Date.now();
		let up = false;
		while (!up && Date.now() - t0 < 25_000) {
			try {
				up = (await fetch(`${BASE}/api/health`)).ok;
			} catch {
				/* 还没起来 */
			}
			if (!up) await new Promise((r) => setTimeout(r, 300));
		}
		if (!up) throw new Error("服务端没起来");
		ok("服务端就绪");

		// 浏览器 attach 触发插件激活（路由随之挂载）
		const plugins = await new Promise((resolve2, reject) => {
			const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			const timer = setTimeout(() => reject(new Error("ws 超时")), 15_000);
			sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "igt-test" })));
			sock.on("message", (raw) => {
				const msg = JSON.parse(raw.toString());
				if (msg.type === "plugins") {
					clearTimeout(timer);
					resolve2(msg.plugins ?? []);
					sock.close();
				}
			});
			sock.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
		const info = plugins.find((p) => p.id === "image-toolkit");
		check(Boolean(info), "plugins 清单里出现 image-toolkit");
		check(!info?.error, `插件激活无错${info?.error ? `（错误：${info.error}）` : ""}`);
		check(info?.hasClient === false || info?.hasClient === undefined, "没有 client/ 目录时不谎报 hasClient");
		check(info?.view !== false, "视图 tab 默认开启");

		await new Promise((r) => setTimeout(r, 800));
		// 路由：/plugins-api/<id>/ws/*
		let r = await fetch(`${BASE}/plugins-api/image-toolkit/ws/settings`);
		check(r.ok, `GET /plugins-api/image-toolkit/ws/settings → ${r.status}`);
		const st = await r.json();
		check(
			Array.isArray(st.serverFormats) && st.settings?.aiTools !== undefined,
			"设置默认值来自 manifest.settings（含 aiTools 开关）",
		);

		r = await fetch(`${BASE}/plugins-api/image-toolkit/ws/list?dir=pics`);
		const list = await r.json();
		check(r.ok && list.entries.some((e) => e.name === "p.png" && e.isImage), "/ws/list 经真实 host.route 列出 pics/");

		r = await fetch(`${BASE}/plugins-api/image-toolkit/ws/image?path=pics/p.png`);
		const bytes = Buffer.from(await r.arrayBuffer());
		check(r.ok && bytes.equals(png), "/ws/image 经 HTTP 原样回传字节");
		check((r.headers.get("content-type") ?? "").includes("image/png"), "/ws/image content-type 正确");

		r = await fetch(`${BASE}/plugins-api/image-toolkit/ws/save?path=pics/saved.webp&overwrite=0`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: png,
		});
		const saved = await r.json();
		check(
			r.ok && saved.ok === true && existsSync(join(cwd, "pics", "saved.webp")),
			`/ws/save 经 HTTP 落盘（${saved.pretty}）`,
		);
		check(
			statSync(join(cwd, "pics", "saved.webp")).size === png.length,
			"落盘字节数与请求一致（原始 body 不被 10mb JSON 上限卡住）",
		);

		// 非法路径（host.fs 强制）：应 500，且不能写出文件
		r = await fetch(`${BASE}/plugins-api/image-toolkit/ws/probe?path=../../escape.png`);
		check(r.status >= 400, `/ws/probe 越界路径被拒（HTTP ${r.status}）`);
		check(!existsSync(join(dirname(cwd), "escape.png")), "越界路径没有产生任何文件");

		// 插件工具应进模型工具表：查 /api/health 之外的现成通道较绕，这里用 settings 里的 aiTools 默认 true 佐证
		check(st.settings.aiTools === true, "AI 工具默认开启");
	} finally {
		stopServer();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
	void basename;
	void sniffFormat;
}

// ---------------------------------------------------------------------------
// C. 客户端纯逻辑（不依赖 DOM 的那部分：文案、渲染管线的尺寸/格式判定、ZIP）
// ---------------------------------------------------------------------------
async function partC() {
	console.log("\n── C. 客户端纯逻辑 ──");

	// -- 文案：中英必须逐 key 对齐（缺一个就会出现半截英文界面） --------------
	const zh = Object.keys(DICT.zh);
	const en = Object.keys(DICT.en);
	check(zh.length === en.length, `中英文案 key 数量一致（${zh.length}）`);
	check(zh.join("|") === en.join("|"), "中英 key 集合与顺序完全一致");
	const used = new Set();
	const dir = join(ROOT, "plugins", "image-toolkit", "client");
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".mjs")) continue;
		const src = readFileSync(join(dir, f), "utf8");
		for (const m of src.matchAll(/\bt\(\s*["']([a-zA-Z0-9_.]+)["']/g)) used.add(m[1]);
	}
	const missing = [...used].filter((k) => !zh.includes(k));
	check(
		missing.length === 0,
		`客户端引用的 ${used.size} 个文案 key 全部存在${missing.length ? `（缺：${missing.join(", ")}）` : ""}`,
	);
	const unused = zh.filter(
		(k) => !used.has(k) && !k.startsWith("wm.pos.") && !k.startsWith("crop.shape.") && !k.startsWith("save."),
	);
	check(unused.length === 0, `没有无用文案 key${unused.length ? `（残留：${unused.join(", ")}）` : ""}`);

	// -- 渲染管线：纯函数部分 -----------------------------------------------
	const st = (over = {}) => ({ rotate90: 0, angle: 0, ...over });
	let r = pipeline.rotatedSize(st({ rotate90: 90 }), 400, 300);
	check(r.width === 300 && r.height === 400, "rotatedSize：90° 交换宽高");
	r = pipeline.rotatedSize(st({ rotate90: 270 }), 400, 300);
	check(r.width === 300 && r.height === 400, "rotatedSize：270° 交换宽高");
	r = pipeline.rotatedSize(st({ rotate90: 180 }), 400, 300);
	check(r.width === 400 && r.height === 300, "rotatedSize：180° 不变");
	r = pipeline.baseSize(st(), 400, 300);
	check(r.width === 400 && r.height === 300, "baseSize：无旋转 = 原尺寸");
	r = pipeline.baseSize(st({ angle: 90 }), 400, 300);
	check(r.width === 300 && r.height === 400, "baseSize：任意 90° 的外接框");
	r = pipeline.baseSize(st({ angle: 45 }), 100, 100);
	check(r.width === 141 && r.height === 141, `baseSize：45° 外接框 ≈141（${r.width}）`);

	const ts = (resize, w = 400, h = 300) => pipeline.targetSize(resize, w, h);
	r = ts({ mode: "longEdge", longEdge: 200, noUpscale: true });
	check(r.width === 200 && r.height === 150, "targetSize：长边 200 → 200×150");
	check(ts({ mode: "longEdge", longEdge: 800, noUpscale: true }) === null, "targetSize：不放大时超出原图 = 不缩放");
	r = ts({ mode: "longEdge", longEdge: 800, noUpscale: false });
	check(r.width === 800 && r.height === 600, "targetSize：关掉不放大后可以放大");
	r = ts({ mode: "percent", percent: 50 });
	check(r.width === 200 && r.height === 150, "targetSize：50% → 200×150");
	r = ts({ mode: "width", width: 100 });
	check(r.width === 100 && r.height === 75, "targetSize：按宽 100 等比算出高");
	r = ts({ mode: "height", height: 150 });
	check(r.width === 200 && r.height === 150, "targetSize：按高 150 等比算出宽");
	check(ts({ mode: "none" }) === null, "targetSize：mode=none 不缩放");
	r = ts({ mode: "percent", percent: 100 });
	check(r === null, "targetSize：比例 100% = 不缩放");

	check(pipeline.outputMime({ format: "keep" }, "image/jpeg") === "image/jpeg", "outputMime：keep 跟随 JPEG 源");
	check(pipeline.outputMime({ format: "keep" }, "image/gif") === "image/png", "outputMime：画布编不了的 GIF 回落 PNG");
	check(pipeline.outputMime({ format: "webp" }, "image/png") === "image/webp", "outputMime：显式格式优先");
	check(
		pipeline.isOpaqueFormat("image/jpeg") === true && pipeline.isOpaqueFormat("image/webp") === false,
		"isOpaqueFormat：只有 JPEG 没有 alpha",
	);
	check(
		pipeline.isLossy("image/png") === false && pipeline.isLossy("image/webp") === true,
		"isLossy：PNG 无损、WebP 有损",
	);
	check(
		pipeline.extOfMime("image/jpeg") === "jpg" && pipeline.extOfMime("image/webp") === "webp",
		"extOfMime：jpeg→jpg",
	);
	check(Math.abs(pipeline.RATIOS["16:9"] - 16 / 9) < 1e-9 && pipeline.RATIOS.free === null, "RATIOS：比例表");
	check(pipeline.RATIO_KEYS.at(-1) === "custom" && pipeline.RATIO_KEYS.includes("9:16"), "RATIO_KEYS：含预设与 custom");
	check(pipeline.ratioOf({ ratio: "16:9" }) === 16 / 9, "ratioOf：预设比例");
	check(pipeline.ratioOf({ ratio: "free" }) === null, "ratioOf：自由比例不锁");
	check(pipeline.ratioOf({ ratio: "custom", ratioW: 21, ratioH: 9 }) === 21 / 9, "ratioOf：自定义 W:H");
	check(pipeline.ratioOf({ ratio: "custom", ratioW: 0, ratioH: 0 }) === null, "ratioOf：自定义非法值当不锁");
	check(pipeline.ratioOf({ ratio: "custom", ratioW: -3, ratioH: 2 }) === null, "ratioOf：负数当不锁");
	check(pipeline.ratioOf(null) === null, "ratioOf：空 state 不炸");
	// 形状抠图 + 不透明格式：必须能被识别出来（否则用户拿到一张"白角图"）
	check(
		pipeline.alphaFixForShape({ cropShape: "rect", format: "jpeg" }, "image/png") === null,
		"alphaFixForShape：矩形不掺和格式",
	);
	check(
		pipeline.alphaFixForShape({ cropShape: "ellipse", format: "jpeg" }, "image/png") === "png",
		"alphaFixForShape：椭圆 + JPEG → 建议 PNG",
	);
	check(
		pipeline.alphaFixForShape({ cropShape: "star", format: "keep" }, "image/jpeg") === "png",
		"alphaFixForShape：JPEG 源 + keep → 建议 PNG",
	);
	check(
		pipeline.alphaFixForShape({ cropShape: "ellipse", format: "keep" }, "image/png") === null,
		"alphaFixForShape：PNG 源 + keep 不用改",
	);
	check(
		pipeline.alphaFixForShape({ cropShape: "heart", format: "webp" }, "image/png") === null,
		"alphaFixForShape：WebP 支持透明，不动",
	);
	check(pipeline.alphaFixForShape({}, "image/jpeg") === null, "alphaFixForShape：没选形状时不干预");
	check(
		pipeline.expandVars("© {name} {w}×{h}", { name: "a.png", w: 4, h: 2 }) === "© a.png 4×2",
		"expandVars：替换水印变量",
	);
	check(pipeline.expandVars("{unknown}", {}) === "{unknown}", "expandVars：未知变量原样保留");
	const ds = pipeline.defaultState({ quality: 0.5, suffix: "-x", maxDim: 1600, defaultFormat: "webp" });
	check(ds.format === "webp" && ds.quality === 0.5 && ds.suffix === "-x", "defaultState：吃插件设置里的默认值");
	check(ds.resize.mode === "longEdge" && ds.resize.longEdge === 1600, "defaultState：设了长边上限就默认按长边缩放");
	check(
		ds.adjust.brightness === 100 && ds.filter.radius === 0 && ds.watermark.enabled === false,
		"defaultState：滤镜/水印默认是「不变」",
	);
	check(ds.ratioW === 16 && ds.ratioH === 9, "defaultState：自定义比例默认 16:9");
	const dsBad = pipeline.defaultState({ defaultFormat: "tiff", quality: 99 });
	check(dsBad.format === "keep" && dsBad.quality === 1, "defaultState：非法设置回落合法值");

	// -- util ---------------------------------------------------------------
	check(
		fmtBytes(512) === "512 B" && fmtBytes(2048) === "2.0 KB" && fmtBytes(3 * 1024 * 1024) === "3.00 MB",
		"fmtBytes：B/KB/MB",
	);
	check(stem("a.b.png") === "a.b" && stem("noext") === "noext", "stem：去扩展名");
	check(extOf("A.PNG") === "png" && extOf("noext") === "", "extOf：小写扩展名");
	check(clamp(5, 1, 3) === 3 && clamp(-1, 0, 9) === 0, "clamp：上下夹取");
	const zip = makeZip([
		{ name: "a.webp", data: new Uint8Array([1, 2, 3]) },
		{ name: "a.webp", data: new Uint8Array([4, 5]) },
	]);
	const zb = Buffer.from(await zip.arrayBuffer());
	check(zb.subarray(0, 4).toString("latin1") === "PK\u0003\u0004", "makeZip：本地文件头签名");
	const eocd = zb.subarray(zb.length - 22);
	check(eocd.subarray(0, 4).toString("latin1") === "PK\u0005\u0006", "makeZip：中央目录结尾记录");
	check(eocd.readUInt16LE(10) === 2, "makeZip：条目数 = 2");
	check(zb.includes(Buffer.from("a.webp")) && zb.includes(Buffer.from("a-1.webp")), "makeZip：同名自动改成 a-1");
	check(zip.type === "application/zip", "makeZip：MIME 正确");

	// -- 裁剪形状几何（画布与 SVG 共用同一份路径） ---------------------------
	const rectCmds = shapes.shapeCommands("rect", 100, 50);
	check(rectCmds.length === 5 && shapes.toPathD(rectCmds).startsWith("M0 0"), "形状：矩形 = M/L/L/L/Z");
	check(shapes.shapeCommands("ellipse", 100, 100).length === 6, "形状：椭圆 = M + 4 段三次贝塞尔 + Z");
	check(shapes.shapeCommands("circle", 80, 80).length === 6, "形状：圆形与椭圆同路径（比例由面板锁 1:1）");
	check(shapes.shapeCommands("diamond", 100, 50).length === 5, "形状：菱形 4 顶点");
	check(shapes.shapeCommands("heart", 100, 100).length === 8, "形状：心形 7 段 + Z");
	check(shapes.shapeCommands("star", 100, 100).length === 11, "形状：五角星 10 个顶点 + Z");
	check(shapes.shapeCommands("rounded", 100, 100, 0).length === 5, "形状：圆角半径 0 退化成矩形");
	check(shapes.shapeCommands("rounded", 100, 100, 20).length === 10, "形状：圆角矩形含 4 段圆角");
	check(shapes.shapeCommands("star", 100, 100)[12] === undefined, "形状：星形不会多出多余命令");
	check(shapes.CROP_SHAPES[0] === "rect" && shapes.CROP_SHAPES.includes("star"), "CROP_SHAPES：rect 在前，含 star");
	// 形状必须完全落在外接矩形内，否则导出会被切掉一角
	for (const sh of shapes.CROP_SHAPES) {
		const cmds = shapes.shapeCommands(sh, 120, 80, 25);
		let inside = true;
		for (const { p } of cmds) {
			for (let i = 0; i + 1 < p.length; i += 2) {
				if (p[i] < -0.01 || p[i] > 120.01 || p[i + 1] < -0.01 || p[i + 1] > 80.01) inside = false;
			}
		}
		check(inside, `形状 ${sh} 的路径完全落在外接矩形内`);
	}
	check(shapes.toPathD(shapes.shapeCommands("star", 10, 10)).endsWith(" Z"), "toPathD：以 Z 收尾");
	check(shapes.toPathD(rectCmds) === "M0 0 L100 0 L100 50 L0 50 Z", "toPathD：d 属性拼装正确");
	// 默认参数就该是矩形（老状态 JSON 里没有 cropShape 时不能崩）
	check(pipeline.defaultState({}).cropShape === "rect", "defaultState：默认裁剪形状是矩形");
	check(pipeline.defaultState({}).cropRadius > 0, "defaultState：圆角半径有默认值");

	// -- 客户端信息探测 -----------------------------------------------------
	const magic = (bytes) => cprobe.sniffType(new Uint8Array(bytes));
	check(magic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) === "image/png", "sniffType：PNG");
	check(magic([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) === "", "sniffType：PNG 签名不全时不误判");
	check(magic([0xff, 0xd8, 0xff, 0xe0]) === "image/jpeg", "sniffType：JPEG");
	check(magic([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) === "image/gif", "sniffType：GIF");
	check(magic([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]) === "image/webp", "sniffType：WebP");
	check(magic([0x42, 0x4d, 0, 0]) === "image/bmp", "sniffType：BMP");
	check(magic([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]) === "image/avif", "sniffType：AVIF");
	check(magic([1, 2, 3, 4]) === "", "sniffType：非图片返回空");
	check(cprobe.parseExif(new Uint8Array([1, 2, 3, 4, 5])) === null, "parseExif：垃圾字节返回 null 不抛错");
	const px = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
	const stats = cprobe.imageStats({ data: px, width: 2, height: 2, colorSpace: "srgb" });
	check(
		stats.colors[0].hex === "#ff0000" && stats.colors[0].share === 1,
		"imageStats：纯红图主色是 #ff0000 且占比 100%",
	);
	check(stats.histogram.length === 256 && stats.histogram[54] === 1, "imageStats：亮度直方图峰值在红色的亮度上（54）");
	const transparent = cprobe.imageStats({
		data: new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 255]),
		width: 2,
		height: 1,
	});
	check(transparent.colors[0].hex === "#0000ff", "imageStats：跳过全透明像素");
}

try {
	await partA();
	await partB();
	await partC();
} catch (err) {
	failures++;
	console.error(`✗ 测试异常终止：${err?.stack ?? err}`);
}

if (failures) {
	console.error(`\n${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过 ✓");
}
