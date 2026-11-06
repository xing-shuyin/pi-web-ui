import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeFetchError, proxyFetch } from "./net.mjs";
import { KEY_RE, createStore } from "./store.mjs";
import { createEngineBridge } from "./engine-bridge.mjs";
import { createTools } from "./tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES_MAX = 64 * 1024;

function rulesFileOf() {
	for (const file of [join(HERE, "rules.md"), join(HERE, "..", "rules.md")]) {
		if (existsSync(file)) return file;
	}
	return null;
}

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

		const metaOf = (key) => {
			if (!KEY_RE.test(key)) return null;
			try {
				const st = statSync(join(store.dir, `${key}.json`));
				return st.isFile() ? { size: st.size, mtime: Math.round(st.mtimeMs) } : null;
			} catch {
				return null;
			}
		};
		const metasOf = () => {
			const out = {};
			for (const key of store.listKeys()) {
				const m = metaOf(key);
				if (m) out[key] = m;
			}
			return out;
		};

		const parsedBody = (req) =>
			req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? req.body : null;

		const MAX_RAW_BODY_BYTES = 10 * 1024 * 1024;

		const readRawBody = (req) => {
			if (Buffer.isBuffer(req.body))
				return Promise.resolve(
					req.body.length > MAX_RAW_BODY_BYTES ? req.body.subarray(0, MAX_RAW_BODY_BYTES) : req.body,
				);
			if (req.readableEnded || req.complete) return Promise.resolve(Buffer.alloc(0));
			return new Promise((resolve) => {
				const chunks = [];
				let total = 0;
				const done = () => resolve(Buffer.concat(chunks));
				req.on("data", (c) => {
					if (total >= MAX_RAW_BODY_BYTES) return;
					const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
					total += chunk.length;
					if (total > MAX_RAW_BODY_BYTES) chunks.push(chunk.subarray(0, MAX_RAW_BODY_BYTES - (total - chunk.length)));
					else chunks.push(chunk);
				});
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
			} catch {}

			try {
				const r = await proxyFetch({ url: targetRaw, method, headers, body, charset });
				json(res, 200, { url: r.url, body: r.body, headers: r.headers, status: r.status });
			} catch (err) {
				const message = describeFetchError(err);
				host.log(`proxy 失败 ${targetRaw}: ${message}`);
				json(res, 502, { error: message });
			}
		};

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

		const offMessage =
			typeof host.onMessage === "function"
				? host.onMessage((payload, from) => {
						if (!from || payload?.type !== "info") return;
						host.sendTo(from, {
							kind: "info",
							sourcesFile: join(store.dir, "sources.json"),
							rulesFile: rulesFileOf(),
							dataDir: store.dir,
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
