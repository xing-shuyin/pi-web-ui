/**
 * web-inspect —— server entry.
 *
 * Left = browser pane (iframe), right = resizable steps sidebar (client/).
 * Step recording works two ways:
 *  - same-origin iframe (local dev pages, liveserver previews): the tab
 *    observes/captures DOM directly and syncs steps up via onMessage;
 *  - any other site: the bookmarklet runs in-page and beacons back via
 *    preflight-free GET /collect (no CORS), or same-origin POST /collect.
 *
 * Model-facing surface = 6 JSON-Schema agent tools (MCP tool conventions:
 * name / description / input schema), callable directly by any in-chat model:
 * web_inspect_state, web_inspect_log, web_inspect_steps, web_inspect_note,
 * web_inspect_clear, web_inspect_report.
 */
import { definePlugin } from "./sdk/index.mjs";

const MAX_LOG = 300;

function clip(v, n = 300) {
	const s = String(v ?? "");
	return s.length > n ? `${s.slice(0, n)}…` : s;
}


/**
 * Injected recorder: same capture core as the bookmarklet, but runs as a
 * plain page script (tokens replaced per request). ALERT=0 under proxy so
 * picks don't popup inside the iframe.
 */
const RECORDER_SRC = `(()=>{const EP=__EP_JSON__;const MSK=__MSK__;const ALERT=__ALERT__;const B=o=>{new Image().src=EP+'/collect?d='+encodeURIComponent(JSON.stringify(o)).slice(0,7000)};const css=e=>{if(e.id)return '#'+e.id;const p=[];let n=e;for(let d=0;n&&n.nodeType===1&&d<5;n=n.parentNode,d++){let s=n.tagName.toLowerCase();if(n.className&&typeof n.className==='string'){const c=n.className.trim().split(/\\s+/).slice(0,2).join('.');if(c)s+='.'+c}const sib=[... (n.parentNode?.children||[])].filter(x=>x.tagName===n.tagName);if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(n)+1)+')';p.unshift(s)}return p.join('>')};const txt=e=>{if(MSK&&(e.type==='password'||e.getAttribute?.('type')==='password'))return '(typed, masked)';return (e.innerText||e.value||e.placeholder||e.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ').slice(0,80)};const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0};const els=[...document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]')].filter(vis).slice(0,60).map((e,i)=>({i,tag:e.tagName.toLowerCase(),text:txt(e),sel:css(e),href:e.href?.slice(0,300),name:e.name,type:e.type}));B({type:'snapshot',url:location.href,title:document.title,count:els.length,elements:els});if(!window.__WI_LOGGED){window.__WI_LOGGED=1;for(const[ev,fn]of[['click',e=>txt(e.target)],['input',e=>e.target.name||e.target.placeholder||txt(e.target)],['submit',e=>txt(e.target)],['change',e=>e.target.name||txt(e.target)]])document.addEventListener(ev,e=>{const tgt=e.target.closest('a,button,input,select,textarea,[role=button]');B({type:'event',ev,url:location.href,text:fn(e).slice(0,120),sel:tgt?css(tgt):''})},true)}if(window.__WI_PICK)return;window.__WI_PICK=1;const box=document.createElement('div');box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #f00;background:#f002';document.body.appendChild(box);const mv=e=>{const tgt=e.target.closest('a,button,input,select,textarea,[role=button],div,span,li,td,h1,h2,h3,p');if(!tgt)return;window.__WI_T=tgt;const r=tgt.getBoundingClientRect();Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'})};const done=e=>{if(e.key==='Escape'){cleanup()}};const pick=e=>{e.preventDefault();e.stopPropagation();const tgt=window.__WI_T||e.target;const md='['+tgt.tagName.toLowerCase()+'] '+txt(tgt)+'\\n sel: '+css(tgt)+'\\n @ '+location.href;B({type:'pick',url:location.href,tag:tgt.tagName.toLowerCase(),text:txt(tgt),sel:css(tgt),path:css(tgt)});try{navigator.clipboard.writeText(md)}catch{}cleanup();if(ALERT)alert(('Sent back to pi-web-ui ✅\\n')+md)};function cleanup(){window.__WI_PICK=0;document.removeEventListener('mousemove',mv,true);document.removeEventListener('click',pick,true);document.removeEventListener('keydown',done,true);box.remove()}document.addEventListener('mousemove',mv,true);document.addEventListener('click',pick,true);document.addEventListener('keydown',done,true);})();`;

function blankState() {
	return { page: null, snapshot: null, picked: null, log: [], steps: [] };
}

function settingsOf(host) {
	let maxSteps = 100;
	try {
		const s = host.getSettings?.() ?? {};
		if (typeof s.maxSteps === "number" && s.maxSteps >= 20) maxSteps = Math.min(500, Math.floor(s.maxSteps));
	} catch {}
	return { maxSteps };
}

function loadState(host) {
	try {
		const s = host.storage.get("state", null);
		if (s && typeof s === "object") {
			return {
				...blankState(),
				...s,
				log: Array.isArray(s.log) ? s.log : [],
				steps: Array.isArray(s.steps) ? s.steps : [],
			};
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

function pushStep(state, maxSteps, step) {
	if (!step || typeof step !== "object") return;
	const last = state.steps[state.steps.length - 1];
	const kinds = new Set(["visit", "click", "input", "pick", "snap", "note", "nav", "select"]);
	const kind = kinds.has(String(step.kind)) ? String(step.kind) : "note";
	const label = clip(step.label, 200);
	const sel = step.sel ? clip(step.sel, 300) : undefined;
	const url = step.url ? clip(step.url, 500) : undefined;
	if (last && last.kind === kind && last.label === label && (last.sel || "") === (sel || "") && (last.url || "") === (url || "")) return;
	state.steps.push({
		n: state.steps.length + 1,
		kind,
		label,
		sel,
		text: step.text ? clip(step.text, 200) : undefined,
		url,
		t: new Date().toISOString(),
	});
	while (state.steps.length > maxSteps) state.steps.shift();
	state.steps.forEach((s, i) => (s.n = i + 1));
}

/** shortcut: truncate oversized snapshots so the beacon stays usable; chunked beacons (seq/total) are v2. */
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

function ingest(host, ctx, obj) {
	const { state } = ctx;
	const maxSteps = ctx.settings().maxSteps;
	if (!obj || typeof obj !== "object") return null;
	const type = String(obj.type || "");
	if (type === "snapshot") {
		const snap = tidySnapshot(obj);
		if (!snap) return null;
		state.snapshot = snap;
		state.page = { url: snap.url, title: snap.title, at: snap.at };
		pushLog(state, "snap", `snapshot ${snap.title || "(untitled)"} (${snap.count} elements) ${snap.url}`);
		pushStep(state, maxSteps, { kind: "snap", label: `${snap.title || snap.url}`, url: snap.url });
	} else if (type === "pick") {
		state.picked = {
			tag: clip(obj.tag, 24),
			text: clip(obj.text, 200),
			sel: clip(obj.sel, 300),
			path: clip(obj.path, 500),
			url: clip(obj.url, 500),
			at: new Date().toISOString(),
		};
		pushLog(state, "pick", `picked [${state.picked.tag}] ${state.picked.text} → ${state.picked.sel}`);
		pushStep(state, maxSteps, { kind: "pick", label: `pick [${state.picked.tag}] ${state.picked.text}`, sel: state.picked.sel, url: state.picked.url });
	} else if (type === "event") {
		const ev = String(obj.ev || "event");
		const map = { click: "click", input: "input", submit: "click", change: "input", nav: "nav", select: "select" };
		pushLog(state, ev, `${clip(obj.text, 160)} → ${clip(obj.sel, 220)} @ ${clip(obj.url, 200)}`);
		pushStep(state, maxSteps, { kind: map[ev] || "note", label: `${clip(obj.text, 120) || ev}`, sel: clip(obj.sel, 220), url: clip(obj.url, 200) });
	} else if (type === "step") {
		pushStep(state, maxSteps, obj);
		pushLog(state, "step", `${obj.kind}: ${clip(obj.label, 160)}`);
	} else if (type === "note") {
		const text = clip(obj.text, 500).trim();
		if (!text) return null;
		pushLog(state, "note", text);
		pushStep(state, maxSteps, { kind: "note", label: text });
	} else {
		return null;
	}
	saveState(host, state);
	return state;
}

function stepsMarkdown(steps, limit = 100) {
	const rows = steps.slice(-limit);
	if (!rows.length) return "(no steps recorded yet)";
	return rows.map((s) => `${s.n}. [${s.kind}] ${s.label}${s.sel ? `\n   sel: ${s.sel}` : ""}${s.url && !s.label.includes(s.url) ? `\n   @ ${s.url}` : ""}`).join("\n");
}

function toMarkdown(state, task) {
	const out = [];
	if (task) out.push(`task: ${clip(task, 500)}\n`);
	const p = state.page;
	out.push(`page: ${p ? `${p.title || "(untitled)"} <${p.url}>` : "(no snapshot yet — capture a page first)"}`);
	if (state.picked) {
		const k = state.picked;
		out.push(`picked: [${k.tag}] ${k.text}\n  sel: ${k.sel}`);
	}
	out.push(`steps:\n${stepsMarkdown(state.steps)}`);
	const snap = state.snapshot;
	if (snap?.elements?.length) {
		out.push(`elements (${snap.count} total, showing ${Math.min(30, snap.elements.length)}):`);
		for (const el of snap.elements.slice(0, 30)) {
			out.push(`- [${el.i}] <${el.tag}> ${el.text || ""} :: ${el.sel}`);
		}
	}
	return out.join("\n");
}

export default definePlugin({
	async activate(host) {
		let state = loadState(host);
		const settings = () => settingsOf(host);
		const ctx = { state, settings };
		const broadcast = () => {
			try {
				host.broadcast({ kind: "web-inspect", state });
			} catch {}
		};
		const refreshCtx = () => {
			ctx.state = state;
		};

		const offSettings = host.onSettingsChanged?.(() => {
			const max = settings().maxSteps;
			while (state.steps.length > max) state.steps.shift();
			state.steps.forEach((s, i) => (s.n = i + 1));
			saveState(host, state);
		});

		const offMsg = host.onMessage((payload, from) => {
			const p = payload ?? {};
			if (p.action === "step" && p.step && typeof p.step === "object") {
				if (ingest(host, ctx, { type: "step", ...p.step })) {
					refreshCtx();
					broadcast();
				}
			} else if (p.action === "steps" && Array.isArray(p.steps)) {
				const max = settings().maxSteps;
				state.steps = p.steps
					.filter((s) => s && typeof s === "object")
					.slice(-max)
					.map((s, i) => ({
						n: i + 1,
						kind: String(s.kind || "note").slice(0, 16),
						label: clip(s.label, 200),
						sel: s.sel ? clip(s.sel, 300) : undefined,
						text: s.text ? clip(s.text, 200) : undefined,
						url: s.url ? clip(s.url, 500) : undefined,
						t: String(s.t || new Date().toISOString()),
					}));
				saveState(host, state);
				broadcast();
			} else if (p.action === "clear") {
				state.log = [];
				state.steps = [];
				saveState(host, state);
				broadcast();
			} else if (p.action === "note" && String(p.text || "").trim()) {
				if (ingest(host, ctx, { type: "note", text: p.text })) {
					refreshCtx();
					broadcast();
				}
			} else if (p.action === "getSettings" && from) {
				try {
					host.sendTo(from, { kind: "web-inspect-settings", settings: host.getSettings?.() ?? {} });
				} catch {}
			}
		});

		const collect = (obj) => {
			const r = ingest(host, ctx, obj);
			refreshCtx();
			return r;
		};

		// Preflight-free GET beacon: bookmarklet posts back cross-origin (pick/event/small snapshot), no CORS needed.
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

		// Same-origin JSON: big snapshots / tab sync / notes.
		const offPost = host.route("POST", "/collect", (req, res) => {
			if (!collect(req.body ?? {})) {
				res.status(400).json({ ok: false, error: "bad payload" });
				return;
			}
			broadcast();
			res.json({ ok: true });
		});


		// Same-origin proxy: fetch target server-side, strip framing/CSP bans,
		// inject <base> + recorder. Makes localhost (and mobile) fully
		// recordable in-tab. Note: login cookies are NOT forwarded — logged-in
		// pages must use the bookmarklet instead.
		const offProxy = host.route("GET", "/proxy", async (req, res) => {
			try {
				const raw = String(req.query?.url ?? "");
				const ep = String(req.query?.ep ?? "").slice(0, 500);
				const msk = String(req.query?.msk ?? "1") === "1";
				if (!/^https?:\/\//i.test(raw) || raw.length > 2000) {
					res.status(400).json({ ok: false, error: "bad url (absolute http(s) required)" });
					return;
				}
				const ctl = new AbortController();
				const timer = setTimeout(() => ctl.abort(), 15_000);
				let resp;
				try {
					resp = await fetch(raw, {
						signal: ctl.signal,
						redirect: "follow",
						headers: { "User-Agent": "pi-web-ui web-inspect", Accept: "text/html,application/xhtml+xml" },
					});
				} finally {
					clearTimeout(timer);
				}
				const ct = resp.headers.get("content-type") || "";
				if (!/html/i.test(ct)) {
					res.status(415).json({ ok: false, error: `not an HTML page (${ct || "unknown type"})` });
					return;
				}
				const buf = new Uint8Array(await resp.arrayBuffer());
				if (buf.length > 2 * 1024 * 1024) {
					res.status(413).json({ ok: false, error: "page too large (>2MB)" });
					return;
				}
				let html = new TextDecoder().decode(buf);
				html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
				const target = new URL(raw);
				const dir = target.pathname.endsWith("/") ? target.pathname : `${target.pathname.slice(0, target.pathname.lastIndexOf("/") + 1)}`;
				const base = `${target.origin}${dir}`;
				const script = `<script>${RECORDER_SRC.replace("__EP_JSON__", JSON.stringify(ep)).replace("__MSK__", msk ? "1" : "0").replace("__ALERT__", "0")}</scr` + `ipt>`;
				if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}<base href="${base}">\n${script}`);
				else html = `<base href="${base}">\n${script}\n${html}`;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.setHeader("Cache-Control", "no-store");
				res.send(html);
			} catch (err) {
				const code = err?.name === "AbortError" ? 504 : 502;
				res.status(code).json({ ok: false, error: String(err?.message ?? err).slice(0, 200) });
			}
		});

		const offState = host.route("GET", "/state", (_req, res) => {
			res.json({ ok: true, state });
		});

		const offSettingsRoute = host.route("GET", "/settings", (_req, res) => {
			res.json({ ok: true, settings: host.getSettings?.() ?? {} });
		});

		async function saveReport(task) {
			const md = `# Web Inspect report\n\n${toMarkdown(state, task)}\n`;
			const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const rel = `web-inspect/report-${stamp}.md`;
			try {
				await host.fs.mkdir("web-inspect");
			} catch {}
			await host.fs.write(rel, md);
			return { path: rel, markdown: md };
		}

		const offReportRoute = host.route("POST", "/report", async (req, res) => {
			try {
				const r = await saveReport(String(req.body?.task ?? ""));
				res.json({ ok: true, ...r });
			} catch (err) {
				res.status(500).json({ ok: false, error: String(err?.message ?? err).slice(0, 300) });
			}
		});

		const tools = [
			{
				name: "web_inspect_state",
				label: "Web Inspect State",
				description:
					"Read the latest page snapshot, picked element and interaction log captured from the user's browser (Markdown). Read this before helping debug a page.",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: toMarkdown(state, "") }] }),
			},
			{
				name: "web_inspect_log",
				label: "Web Inspect Log",
				description:
					"Read the tail of the interaction log, filterable by kind: pick (element picks) / snap (snapshots) / click / input / submit / change / note / event / step.",
				parameters: {
					type: "object",
					properties: {
						limit: { type: "number", description: "Max entries to return, default 50, max 300" },
						kind: { type: "string", description: "Only entries of this kind, e.g. pick / click / input" },
					},
				},
				execute: async (_id, params) => {
					const limit = Math.max(1, Math.min(300, Number(params?.limit ?? 50) || 50));
					const kind = String(params?.kind ?? "").trim();
					const rows = (kind ? state.log.filter((l) => l.kind === kind) : state.log).slice(-limit);
					const text = rows.length
						? rows.map((l) => `[${l.t}] ${l.kind}: ${l.text}`).join("\n")
						: "(no matching log entries yet — capture a page first)";
					return { content: [{ type: "text", text }] };
				},
			},
			{
				name: "web_inspect_steps",
				label: "Web Inspect Steps",
				description:
					"Read the user's recorded step-by-step flow: page visits, clicks, inputs, picks and notes, in order with CSS selectors. Use this to replay or debug what the user did.",
				parameters: {
					type: "object",
					properties: {
						limit: { type: "number", description: "Max steps to return, default 100" },
					},
				},
				execute: async (_id, params) => {
					const limit = Math.max(1, Math.min(500, Number(params?.limit ?? 100) || 100));
					return { content: [{ type: "text", text: stepsMarkdown(state.steps, limit) }] };
				},
			},
			{
				name: "web_inspect_note",
				label: "Web Inspect Note",
				description: "Append a note to the user's inspection log (visible in the Web Inspect tab).",
				parameters: {
					type: "object",
					properties: { text: { type: "string", description: "Note text" } },
					required: ["text"],
				},
				execute: async (_id, params) => {
					const text = String(params?.text ?? "").trim();
					if (!text) throw new Error("text is required");
					collect({ type: "note", text });
					broadcast();
					return { content: [{ type: "text", text: "noted" }] };
				},
			},
			{
				name: "web_inspect_clear",
				label: "Web Inspect Clear",
				description: "Clear the inspection log and recorded steps.",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					state.log = [];
					state.steps = [];
					saveState(host, state);
					broadcast();
					return { content: [{ type: "text", text: "cleared" }] };
				},
			},
			{
				name: "web_inspect_report",
				label: "Web Inspect Report",
				description:
					"Save the current inspection (task + page + steps + picked element + snapshot) as a Markdown file under web-inspect/ in the workspace and return its path. The user attaches it to chat for debugging.",
				parameters: {
					type: "object",
					properties: {
						task: { type: "string", description: "What the user wants to do / what is broken" },
					},
				},
				execute: async (_id, params) => {
					const r = await saveReport(String(params?.task ?? ""));
					broadcast();
					return { content: [{ type: "text", text: `saved: ${r.path}\n\n${r.markdown}` }] };
				},
			},
		];
		const offTools = tools.map((t) => host.registerAgentTool(t));

		host.log("web-inspect ready: browser+steps tab, beacon /collect, 6 agent tools");
		return () => {
			for (const off of [offSettings, offMsg, offBeacon, offPost, offState, offSettingsRoute, offReportRoute, offProxy, ...offTools]) {
				try {
					off?.();
				} catch {}
			}
		};
	},
});
