/**
 * web-inspect —— 服务端入口。
 *
 * 思路（对标 Codex Browser Use / Playwright MCP 的 snapshot→act 循环，
 * 但跑在用户自己的浏览器里，免装扩展、登录态天然可用）：
 *
 * - 用户在目标网站点收藏夹书签（bookmarklet），快照/点选/交互日志经
 *   无预检 GET 信标 `GET /collect?d=<urlencoded json>` 回传（跨域免 CORS)；
 * - 本 Tab（client/entry.mjs，同源）用 POST /collect 传大快照、GET /state 拉全量；
 * - AI 经 agent 工具只读：web_inspect_state（页面+点选+近况日志的 Markdown）、
 *   web_inspect_log（按 kind 过滤的日志尾巴）。写操作（让 AI 反向点页）是 v2，
 *   见 README 路线图（需 client 在线确认的 sendTo 队列）。
 */
import { definePlugin } from "./sdk/index.mjs";

const MAX_LOG = 300;
const MAX_TEXT = 300;

function clip(v, n = MAX_TEXT) {
	const s = String(v ?? "");
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function blankState() {
	return { page: null, snapshot: null, picked: null, log: [] };
}

function loadState(host) {
	try {
		const s = host.storage.get("state", null);
		if (s && typeof s === "object") {
			return { ...blankState(), ...s, log: Array.isArray(s.log) ? s.log : [] };
		}
	} catch {}
	return blankState();
}

function saveState(host, state) {
	try {
		host.storage.set("state", state);
	} catch {}
}

function pushLog(state, kind, text) {
	state.log.push({ t: new Date().toISOString(), kind: String(kind || "event").slice(0, 24), text: clip(text, 500) });
	while (state.log.length > MAX_LOG) state.log.shift();
}

/** shortcut: 快照过大直接截断 elements，保住“最后一公里可用”，升级到分片信标再放宽。 */
function tidySnapshot(raw) {
	if (!raw || typeof raw !== "object") return null;
	const els = Array.isArray(raw.elements) ? raw.elements.slice(0, 80) : [];
	return {
		url: clip(raw.url, 500),
		title: clip(raw.title, 200),
		count: Number(raw.count ?? els.length) || els.length,
		at: new Date().toISOString(),
		elements: els.map((el, i) => ({
			i: Number(el.i ?? i),
			tag: clip(el.tag, 24),
			text: clip(el.text, 120),
			sel: clip(el.sel, 220),
			href: el.href ? clip(el.href, 300) : undefined,
			name: el.name ? clip(el.name, 80) : undefined,
			type: el.type ? clip(el.type, 24) : undefined,
		})),
	};
}

function ingest(host, state, obj) {
	if (!obj || typeof obj !== "object") return null;
	const type = String(obj.type || "");
	if (type === "snapshot") {
		const snap = tidySnapshot(obj);
		if (!snap) return null;
		state.snapshot = snap;
		state.page = { url: snap.url, title: snap.title, at: snap.at };
		pushLog(state, "snap", `快照 ${snap.title}（${snap.count} 个元素） ${snap.url}`);
	} else if (type === "pick") {
		state.picked = {
			tag: clip(obj.tag, 24),
			text: clip(obj.text, 200),
			sel: clip(obj.sel, 300),
			path: clip(obj.path, 500),
			url: clip(obj.url, 500),
			at: new Date().toISOString(),
		};
		pushLog(state, "pick", `点选 [${state.picked.tag}] ${state.picked.text} → ${state.picked.sel}`);
	} else if (type === "event") {
		pushLog(state, String(obj.ev || "event"), `${clip(obj.text, 160)} → ${clip(obj.sel, 220)} @ ${clip(obj.url, 200)}`);
	} else if (type === "note") {
		const text = clip(obj.text, 500).trim();
		if (!text) return null;
		pushLog(state, "note", text);
	} else {
		return null;
	}
	saveState(host, state);
	return state;
}

function toMarkdown(state) {
	const out = [];
	const p = state.page;
	out.push(`页面: ${p ? `${p.title || "(无标题)"} <${p.url}>` : "(尚无快照，用书签抓一页)"}`);
	if (state.picked) {
		const k = state.picked;
		out.push(`点选: [${k.tag}] ${k.text}\n  sel: ${k.sel}`);
	}
	const snap = state.snapshot;
	if (snap?.elements?.length) {
		out.push(`元素 (共 ${snap.count}，列前 ${Math.min(30, snap.elements.length)} 个):`);
		for (const el of snap.elements.slice(0, 30)) {
			out.push(`- [${el.i}] <${el.tag}> ${el.text || ""} :: ${el.sel}`);
		}
	}
	const logs = state.log.slice(-20);
	if (logs.length) {
		out.push("近况日志:");
		for (const l of logs) out.push(`- [${l.t.slice(11, 19)}] ${l.kind}: ${l.text}`);
	}
	return out.join("\n");
}

export default definePlugin({
	async activate(host) {
		let state = loadState(host);
		const broadcast = () => {
			try {
				host.broadcast({ kind: "web-inspect", state });
			} catch {}
		};

		const offMsg = host.onMessage((payload) => {
			const p = payload ?? {};
			if (p.action === "clear") {
				state.log = [];
				saveState(host, state);
				broadcast();
			} else if (p.action === "note" && String(p.text || "").trim()) {
				if (ingest(host, state, { type: "note", text: p.text })) broadcast();
			}
		});

		const collect = (obj) => ingest(host, state, obj);

		// 无预检 GET 信标：bookmarklet 跨域回传（pick/event/小快照），免 CORS。
		const offBeacon = host.route("GET", "/collect", (req, res) => {
			try {
				const raw = String(req.query?.d ?? "");
				if (!raw) {
					res.status(400).json({ ok: false, error: "missing ?d=" });
					return;
				}
				const obj = JSON.parse(decodeURIComponent(raw));
				if (!collect(obj)) {
					res.status(400).json({ ok: false, error: "bad payload" });
					return;
				}
				broadcast();
				res.json({ ok: true });
			} catch (err) {
				res.status(400).json({ ok: false, error: String(err?.message ?? err).slice(0, 200) });
			}
		});

		// 同源 JSON：Tab 内大快照/手动粘贴/备注走这里。
		const offPost = host.route("POST", "/collect", (req, res) => {
			if (!collect(req.body ?? {})) {
				res.status(400).json({ ok: false, error: "bad payload" });
				return;
			}
			broadcast();
			res.json({ ok: true });
		});

		const offState = host.route("GET", "/state", (_req, res) => {
			res.json({ ok: true, state });
		});

		const offToolState = host.registerAgentTool({
			name: "web_inspect_state",
			label: "Web Inspect State",
			description: "读取用户浏览器抓到的最新页面快照、点选元素与交互日志（Markdown）。先读它再帮用户调试页面。",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: toMarkdown(state) }] }),
		});

		const offToolLog = host.registerAgentTool({
			name: "web_inspect_log",
			label: "Web Inspect Log",
			description: "按 kind 过滤读交互日志尾巴：pick（点选）/ snap（快照）/ click / input / submit / change / note / event。",
			parameters: {
				type: "object",
				properties: {
					limit: { type: "number", description: "最多返回条数，默认 50，上限 300" },
					kind: { type: "string", description: "只看该 kind，如 pick / click / input" },
				},
			},
			execute: async (_id, params) => {
				const limit = Math.max(1, Math.min(300, Number(params?.limit ?? 50) || 50));
				const kind = String(params?.kind ?? "").trim();
				const rows = (kind ? state.log.filter((l) => l.kind === kind) : state.log).slice(-limit);
				const text = rows.length
					? rows.map((l) => `[${l.t}] ${l.kind}: ${l.text}`).join("\n")
					: "(暂无匹配日志，让用户先用书签抓一页)";
				return { content: [{ type: "text", text }] };
			},
		});

		host.log("web-inspect 就绪：书签信标 /collect + 工具 web_inspect_state/log");
		return () => {
			for (const off of [offMsg, offBeacon, offPost, offState, offToolState, offToolLog]) {
				try {
					off?.();
				} catch {}
			}
		};
	},
});
