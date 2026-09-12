/**
 * legado-web 插件服务端 —— 内嵌 Legado 阅读前端的后端 + 给 AI 的「修源」接口。
 *
 * 前端是 `app/` 里的 Vite 应用（产物 `client/app/`，宿主 `/plugins/<id>/client/*` 静态托管），
 * 基址由前端 `src/core/apiBase.ts` 推导为 `<前缀>/plugins-api/legado-web`，这里提供：
 *
 *   GET/POST /proxy?url=<目标>&charset=?   书源站抓取（CORS/GBK/cookie jar，见 net.mjs）
 *   GET/POST /store[?key=<键>]             本地存储：书源/书架/进度/检测（见 store.mjs）
 *
 * 另外注册四个 AI 工具（manifest.permissions 需含 "tools"），让 agent 能读规则、读书源文件、
 * 跑链路诊断、试跑单条规则后再改源（见 tools.mjs / rules.md）：
 *   legado_rules / legado_book_sources / legado_source_probe / legado_run_rule
 *
 * 诊断要发好几个外部请求（几秒到几十秒），所以规则引擎跑在独立 worker 里（engine-bridge.mjs +
 * engine-host.mjs），不阻塞主进程的 WS/HTTP；书源 JS 规则里的同步 HTTP（java.ajax…）由
 * sync-bridge.mjs（worker + 共享内存）在 worker 内提供。
 *
 * 数据落地：`<dataDir>/legado-web/*.json`（**不放插件目录**：install --force 更新插件会先删掉
 * 整个插件目录、只保留 config.json，用户攒的书源会被更新洗掉）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeFetchError, proxyFetch } from "./net.mjs";
import { KEY_RE, createStore } from "./store.mjs";
import { createEngineBridge } from "./engine-bridge.mjs";
import { createTools } from "./tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_MAX = 64 * 1024;

/** 规则速查文件（AI 的只读参考；也可用 legado_rules 工具直接读全文）。 */
function rulesFileOf() {
	for (const file of [join(HERE, "rules.md"), join(HERE, "..", "rules.md")]) {
		if (existsSync(file)) return file;
	}
	return null;
}

/** 规则速查（AI 的知识库）：插件目录里的 rules.md。 */
function loadRulesText() {
	const file = rulesFileOf();
	if (!file) {
		return "# Legado 书源规则\n（rules.md 读不到——插件目录被改过？重装插件即可恢复。）";
	}
	try {
		return readFileSync(file, "utf8").slice(0, RULES_MAX);
	} catch {
		return "# Legado 书源规则\n（rules.md 读取失败）";
	}
}

/* 说明：「AI 修复源」只改书源数据（sourcesFile = <dataDir>/legado-web/sources.json）与只读参考 rules.md，
   不往插件本体里写任何东西（插件是安装产物，install --force 会整目录覆盖），也不再把插件/源码目录交给 AI。 */

export default {
	activate(host) {
		const store = createStore({
			dir: process.env.LEGADO_WEB_STORE_DIR || join(host.dataDir, "legado-web"),
			legacyDir: join(host.dir, "storage"),
		});
		const engine = createEngineBridge({ log: (msg) => host.log(msg) });
		const tools = createTools({ host, store, engine, rulesText: loadRulesText() });
		const offTools = tools.map((tool) => host.registerAgentTool(tool));

		const queryOf = (req) => {
			try {
				return new URL(String(req.url ?? "/"), "http://127.0.0.1").searchParams;
			} catch {
				return new URLSearchParams();
			}
		};

		/**
		 * 键文件的版本信息（size + mtimeMs）：前端用它发现“数据目录被外部改过”
		 * （AI 工具改了书源、另一个页面写了、手工编辑），改了就重读重渲染。
		 *
		 * 放 index.mjs 而不是 store.mjs：插件热重载只击穿 index.mjs 的 ESM 缓存，
		 * 依赖模块（store.mjs）仍指向旧实例，改了要等宿主重启才生效。
		 */
		const metaOf = (key) => {
			if (!KEY_RE.test(key)) return null;
			try {
				const st = statSync(join(store.dir, `${key}.json`));
				return st.isFile() ? { size: st.size, mtime: Math.round(st.mtimeMs) } : null;
			} catch {
				return null;
			}
		};
		/** 所有键文件的版本信息（只报存在的文件）。 */
		const metasOf = () => {
			const out = {};
			for (const key of store.listKeys()) {
				const m = metaOf(key);
				if (m) out[key] = m;
			}
			return out;
		};

		/** express.json 已解析出的对象体（解析过就不要再读流——流已被消费，读会挂住）。 */
		const parsedBody = (req) =>
			req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : null;

		/** 未过 express.json 的原始体（非 JSON content-type / 非法 JSON 时）。 */
		const readRawBody = (req) => {
			if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
			if (req.readableEnded || req.complete) return Promise.resolve(Buffer.alloc(0));
			return new Promise((resolve) => {
				const chunks = [];
				const done = () => resolve(Buffer.concat(chunks));
				req.on("data", (c) => chunks.push(c));
				req.on("end", done);
				req.on("close", done);
				req.on("error", done);
			});
		};

		const json = (res, status, obj) => {
			res.status(status);
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.setHeader("Cache-Control", "no-store");
			res.end(JSON.stringify(obj));
		};

		const safeJson = (text) => {
			try {
				return JSON.parse(text);
			} catch {
				return null;
			}
		};

		// ---- /proxy：书源站抓取（仅接受书源自己声明的头，绝不透传浏览器头） ----
		const proxyHandler = async (req, res) => {
			const q = queryOf(req);
			const targetRaw = String(q.get("url") ?? "");
			if (!targetRaw || !/^https?:\/\//i.test(targetRaw)) {
				json(res, 400, { error: "missing ?url=http(s)://..." });
				return;
			}
			const urlCharset = String(q.get("charset") ?? "");
			const headers = {};
			let charset = urlCharset;
			let method = "GET";
			let body;
			try {
				const fromQuery = q.get("headers");
				if (fromQuery) Object.assign(headers, JSON.parse(fromQuery));
				if (String(req.method).toUpperCase() !== "GET") {
					method = "POST";
					const parsed = parsedBody(req);
					const raw = parsed ? Buffer.alloc(0) : await readRawBody(req);
					const payload = parsed ?? (raw.length ? safeJson(raw.toString("utf8")) : null);
					if (payload && typeof payload === "object") {
						Object.assign(headers, payload.headers ?? {});
						if (typeof payload.body === "string" && payload.body) body = payload.body;
						if (!charset && payload.charset) charset = String(payload.charset);
					} else if (raw.length) {
						body = raw;
					}
				}
			} catch {
				/* 头解析失败：用默认头继续 */
			}

			try {
				const r = await proxyFetch({ url: targetRaw, method, headers, body, charset });
				json(res, 200, { url: r.url, body: r.body, headers: r.headers, status: r.status });
			} catch (err) {
				const message = describeFetchError(err);
				host.log(`proxy 失败 ${targetRaw}: ${message}`);
				json(res, 502, { error: message });
			}
		};

		// ---- /store：本地存储（书源/书架/进度/检测） ---------------------------
		//	GET  /store?meta=1        全部键的版本信息（size+mtime）——前端用它发现外部改动
		//	GET  /store?key=<键>      读一个键
		//	POST /store?key=<键>      写一个键（回 ok/bytes/meta）
		const storeHandler = async (req, res) => {
			const q = queryOf(req);
			const rawKey = q.get("key");
			const key = rawKey === null ? null : String(rawKey).trim();
			const wantMeta = q.get("meta") !== null;
			if (key !== null && !KEY_RE.test(key)) {
				json(res, 400, { error: "bad key" });
				return;
			}
			try {
				if (String(req.method).toUpperCase() === "GET") {
					if (wantMeta) {
						json(res, 200, { metas: key ? { [key]: metaOf(key) } : metasOf() });
						return;
					}
					if (!key) {
						json(res, 200, { keys: store.listKeys() });
						return;
					}
					if (!store.has(key)) {
						json(res, 404, { value: null });
						return;
					}
					json(res, 200, { value: store.read(key) });
					return;
				}
				if (!key) {
					json(res, 400, { error: "missing key" });
					return;
				}
				const parsed = parsedBody(req);
				const raw = parsed ? Buffer.alloc(0) : await readRawBody(req);
				let value = parsed ?? (raw.length ? safeJson(raw.toString("utf8")) : null);
				if (value && typeof value === "object" && "value" in value) value = value.value;
				const bytes = store.write(key, value);
				// 回带 meta：前端把自己写的版本记下来，不会把自己的写入误判为“外部改动”
				json(res, 200, { ok: true, key, bytes, meta: metaOf(key) });
			} catch (err) {
				if (String(err?.message ?? "").startsWith("非法键")) {
					json(res, 400, { error: "bad key" });
					return;
				}
				host.log(`store ${req.method} ${key ?? ""} 失败: ${err?.message ?? err}`);
				if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
			}
		};

		const offs = [
			host.route("GET", "/proxy", proxyHandler),
			host.route("POST", "/proxy", proxyHandler),
			host.route("GET", "/store", storeHandler),
			host.route("POST", "/store", storeHandler),
		];

		// 前端（iframe）“AI 修复源”按钮需要知道目录：问一句就回一句。
		// 旧版宿主可能没有 onMessage —— 没有就静默降级（按钮退化成复制到剪贴板）。
		const offMessage =
			typeof host.onMessage === "function"
				? host.onMessage((payload, from) => {
						if (!from || payload?.type !== "info") return;
						host.sendTo(from, {
							kind: "info",
							// AI 修复要改的**只有书源文件**（用 legado_book_sources 工具读写，别直接编辑这个几 MB 的文件）
							sourcesFile: join(store.dir, "sources.json"),
							// 规则速查（只读参考；等价地可用 legado_rules 工具）
							rulesFile: rulesFileOf(),
							// AI 的工作目录：书源数据所在目录（不要让 AI 的 cwd 落到插件目录）
							dataDir: store.dir,
							// 插件本体：**只读**（install --force 会整目录覆盖，往里写也没用）
							pluginDir: host.dir,
							workspace: host.cwd,
						});
					})
				: () => {};

		host.log(
			`激活：代理 + 存储（store=${store.dir}）+ ${tools.length} 个 AI 工具（${tools.map((t) => t.name).join(", ")}）`,
		);

		return () => {
			for (const off of offs) off();
			for (const off of offTools) off();
			offMessage();
			engine.dispose();
		};
	},
};
