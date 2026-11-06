import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { enhanceMarkdownHtml } from "./md-toc.mjs";

const PREFIXES = ["/liveserver", "/md"];
const MAX_BYTES = 10 * 1024 * 1024;
const EVENTS_SUFFIX = "/__livepreview/events";

const MIME = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	mp4: "video/mp4",
	webm: "video/webm",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	txt: "text/plain; charset=utf-8",
	md: "text/html; charset=utf-8",
	map: "application/json; charset=utf-8",
};

const TEXT_EXTS = new Set(["html", "htm", "css", "js", "mjs", "json", "svg", "txt", "md", "map"]);

export function toRelPath(pathname) {
	let p;
	try {
		p = decodeURIComponent(String(pathname ?? ""));
	} catch {
		return null;
	}
	p = p.split("?")[0].split("#")[0];
	if (!p.startsWith("/")) return null;
	const segs = p.split("/").filter((s) => s && s !== ".");
	if (p.includes("\\") || p.includes("\0") || segs.some((s) => s === "..")) return null;
	return segs.join("/");
}

function extOf(rel) {
	const i = rel.lastIndexOf(".");
	return i < 0 ? "" : rel.slice(i + 1).toLowerCase();
}

function escHtml(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderMarkdown(src, title) {
	const lines = String(src ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	const out = [];
	let i = 0;
	let inFence = false;
	let fenceLang = "";
	let fenceBuf = [];
	let listTag = "";
	const closeList = () => {
		if (listTag) {
			out.push(`</${listTag}>`);
			listTag = "";
		}
	};
	const safeUrl = (u) => {
		const t = String(u).trim();
		if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return t;
		return /^(https?:|mailto:)/i.test(t) ? t : "#";
	};
	const inline = (t) => {
		let s = escHtml(t);
		const codes = [];
		s = s.replace(/`([^`]+)`/g, (_, c) => `@@CODE${codes.push(c) - 1}@@`);
		s = s
			.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img alt="${alt}" src="${safeUrl(src)}">`)
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${safeUrl(href)}">${text}</a>`)
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>")
			.replace(/@@CODE(\d+)@@/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
		return s;
	};
	const isTableRow = (l) => /^\|.*\|\s*$/.test(l);
	const isTableDelim = (l) => /^\|?[\s:|-]+\|[\s:|-]+\|?\s*$/.test(l) && l.includes("|");
	while (i < lines.length) {
		const l = lines[i];
		const fence = l.match(/^```(\w*)\s*$/);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceLang = fence[1] || "";
				fenceBuf = [];
			} else {
				inFence = false;
				out.push(
					`<pre><code${fenceLang ? ` class="language-${escHtml(fenceLang)}"` : ""}>${escHtml(fenceBuf.join("\n"))}</code></pre>`,
				);
			}
			i++;
			continue;
		}
		if (inFence) {
			fenceBuf.push(l);
			i++;
			continue;
		}
		const h = l.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			closeList();
			out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
			i++;
			continue;
		}
		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
			closeList();
			out.push("<hr>");
			i++;
			continue;
		}
		if (isTableRow(l) && isTableDelim(lines[i + 1] ?? "")) {
			closeList();
			const cells = (r) =>
				r
					.trim()
					.replace(/^\||\|$/g, "")
					.split("|")
					.map((c) => `<th>${inline(c.trim())}</th>`)
					.join("");
			const headCells = cells(l);
			i += 2;
			const rows = [];
			while (i < lines.length && isTableRow(lines[i])) {
				rows.push(
					`<tr>${lines[i]
						.trim()
						.replace(/^\||\|$/g, "")
						.split("|")
						.map((c) => `<td>${inline(c.trim())}</td>`)
						.join("")}</tr>`,
				);
				i++;
			}
			out.push(`<table><thead><tr>${headCells}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
			continue;
		}
		const quote = l.match(/^>\s?(.*)$/);
		if (quote) {
			closeList();
			const buf = [];
			while (i < lines.length) {
				const q = lines[i].match(/^>\s?(.*)$/);
				if (!q) break;
				buf.push(inline(q[1]));
				i++;
			}
			out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
			continue;
		}
		const ul = l.match(/^\s*[-*+]\s+(.*)$/);
		const ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
		if (ul || ol) {
			const tag = ul ? "ul" : "ol";
			if (listTag !== tag) {
				closeList();
				out.push(`<${tag}>`);
				listTag = tag;
			}
			out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
			i++;
			continue;
		}
		if (!l.trim()) {
			closeList();
			i++;
			continue;
		}
		closeList();
		out.push(`<p>${inline(l)}</p>`);
		i++;
	}
	closeList();
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title || "Markdown 预览")}</title><style>body{max-width:860px;margin:0 auto;padding:24px;font:16px/1.7 system-ui,sans-serif;color:#e8e8e8;background:#1e1e1e}pre{background:#111;padding:12px;overflow:auto;border-radius:8px}code{background:#111;padding:1px 5px;border-radius:4px}pre code{background:none;padding:0}a{color:#6cb6ff}table{border-collapse:collapse}th,td{border:1px solid #555;padding:4px 10px}blockquote{border-left:3px solid #555;margin:8px 0;padding:4px 12px;color:#bbb}img{max-width:100%}</style></head><body>${out.join("\n")}</body></html>`;
}

function dirListing(rel, entries, prefix) {
	const rows = (rel ? [`<li><a href="../">../</a></li>`] : [])
		.concat(
			[...entries]
				.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
				.map((e) => {
					const href = `${rel ? `${rel.split("/").map(encodeURIComponent).join("/")}/` : ""}${encodeURIComponent(e.name)}${e.type === "dir" ? "/" : ""}`;
					return `<li><a href="${href}">${escHtml(e.name)}${e.type === "dir" ? "/" : ""}</a></li>`;
				}),
		)
		.join("\n");
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>/${escHtml(rel)}</title><style>body{max-width:860px;margin:0 auto;padding:24px;font:15px/1.8 system-ui,sans-serif;background:#1e1e1e;color:#e8e8e8}a{color:#6cb6ff}</style></head><body><h2>/${escHtml(rel)} <span style="color:#888;font-size:13px">via ${escHtml(prefix)}</span></h2><ul>${rows}</ul></body></html>`;
}

function withReload(html, prefix, version) {
	const snippet = reloadSnippet(prefix, version);
	return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${snippet}</body>`) : html + snippet;
}

function reloadSnippet(prefix, version) {
	const base = prefix ? `<meta name="live-preview-base" content="${escHtml(prefix)}">` : "";
	return `${base}<script>(function(){var v=${version};function base(){try{var m=document.querySelector('meta[name="live-preview-base"]');if(m&&m.content)return m.content;}catch(_){}return \"\";}try{var es=new EventSource(base()+\"/__livepreview/events\");es.onmessage=function(e){try{var d=JSON.parse(e.data);if(d&&d.version!==v)location.reload();}catch(_){}};}catch(_){}})();</script>`;
}

export default {
	async activate(host) {
		const cleanups = [];
		const off = (fn) => {
			if (typeof fn === "function") cleanups.push(fn);
		};
		const settings = () => {
			try {
				return host.getSettings?.() ?? {};
			} catch {
				return {};
			}
		};
		const capabilityPrefix = `/__live-preview/${randomBytes(32).toString("hex")}`;
		const state = { version: 0, sse: new Set() };
		const bump = () => {
			state.version += 1;
			const msg = `data: ${JSON.stringify({ version: state.version })}\n\n`;
			for (const res of state.sse) {
				try {
					res.write(msg);
				} catch {
					state.sse.delete(res);
				}
			}
		};
		let deb = null;
		const scheduleBump = () => {
			if (deb) return;
			deb = setTimeout(() => {
				deb = null;
				bump();
			}, 300);
		};

		async function handle(req, res) {
			res.setHeader("Content-Security-Policy", "sandbox allow-scripts");
			res.setHeader("X-Content-Type-Options", "nosniff");
			res.setHeader("Referrer-Policy", "no-referrer");
			res.setHeader("Cache-Control", "no-store");
			const pathname = (req.url || "/").split("?")[0];
			const rel = toRelPath(pathname);
			if (rel === null) {
				res.writeHead(400).end("bad path");
				return;
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405).end("method not allowed");
				return;
			}
			const prefix = String(req.headers["x-pi-proxy-prefix"] ?? "");
			if (PREFIXES.includes(prefix)) {
				res.writeHead(302, { Location: capabilityPrefix + pathname }).end();
				return;
			}
			const provided = Buffer.from(prefix);
			const expected = Buffer.from(capabilityPrefix);
			if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
				res.writeHead(403).end("invalid preview capability");
				return;
			}
			res.setHeader("Access-Control-Allow-Origin", "*");
			if (pathname === "/__livepreview/events" || pathname.endsWith(EVENTS_SUFFIX)) {
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				if (req.method === "HEAD") {
					res.end();
					return;
				}
				res.write(`data: ${JSON.stringify({ version: state.version })}\n\n`);
				state.sse.add(res);
				req.on("close", () => state.sse.delete(res));
				return;
			}
			const headOnly = req.method === "HEAD";
			const send = (code, headers, buf) => {
				const range = String(req.headers.range ?? "");
				const m = range.match(/^bytes=(\d*)-(\d*)$/);
				if (m && buf && code === 200) {
					const total = buf.length;
					const start = m[1] === "" ? Math.max(0, total - Number(m[2] || 0)) : Number(m[1]);
					const end = m[2] === "" || m[1] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
					if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < total) {
						res.writeHead(206, {
							...headers,
							"Content-Range": `bytes ${start}-${end}/${total}`,
							"Content-Length": end - start + 1,
							"Accept-Ranges": "bytes",
						});
						res.end(headOnly ? undefined : buf.subarray(start, end + 1));
						return;
					}
				}
				res.writeHead(code, { ...headers, "Content-Length": buf ? buf.length : 0, "Accept-Ranges": "bytes" });
				res.end(headOnly || !buf ? undefined : buf);
			};
			let st;
			try {
				st = rel === "" ? { type: "dir" } : await host.fs.stat(rel);
			} catch {
				res.writeHead(404).end("not found");
				return;
			}
			if (st.type === "dir") {
				if (!pathname.endsWith("/")) {
					res.writeHead(302, { Location: `${prefix}${pathname}/` }).end();
					return;
				}
				const base = rel ? `${rel}/` : "";
				for (const idx of ["index.html", "index.htm"]) {
					try {
						const text = await host.fs.readText(`${base}${idx}`, MAX_BYTES);
						const live = settings().liveReload !== false;
						const html = live ? withReload(text, prefix, state.version) : text;
						send(200, { "Content-Type": MIME.html, "Cache-Control": "no-store" }, Buffer.from(html));
						return;
					} catch {}
				}
				try {
					const entries = await host.fs.list(rel || undefined);
					send(
						200,
						{ "Content-Type": MIME.html, "Cache-Control": "no-store" },
						Buffer.from(dirListing(rel, entries, prefix || "/liveserver")),
					);
				} catch (err) {
					res.writeHead(403).end(String(err?.message ?? err));
				}
				return;
			}
			if ((st.size ?? 0) > MAX_BYTES) {
				res.writeHead(413).end("file too large for preview");
				return;
			}
			const ext = extOf(rel);
			const name = rel.split("/").pop();
			try {
				if (ext === "md" || ext === "markdown") {
					const text = await host.fs.readText(rel, MAX_BYTES);
					const live = settings().liveReload !== false;
					let html = enhanceMarkdownHtml(renderMarkdown(text, name));
					if (live) html = html.replace(/<\/body\s*>/i, `${reloadSnippet(prefix, state.version)}</body>`);
					send(200, { "Content-Type": MIME.html, "Cache-Control": "no-store" }, Buffer.from(html));
					return;
				}
				if (ext === "html" || ext === "htm") {
					const text = await host.fs.readText(rel, MAX_BYTES);
					const live = settings().liveReload !== false;
					const html = live ? withReload(text, prefix, state.version) : text;
					send(200, { "Content-Type": MIME.html, "Cache-Control": "no-store" }, Buffer.from(html));
					return;
				}
				const buf = TEXT_EXTS.has(ext) ? Buffer.from(await host.fs.readText(rel, MAX_BYTES)) : await host.fs.read(rel);
				send(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-store" }, buf);
			} catch (err) {
				if (!res.headersSent) res.writeHead(404).end(String(err?.message ?? err));
				else res.end();
			}
		}

		const server = createServer((req, res) => {
			void handle(req, res).catch((err) => {
				host.log?.("preview handler failed:", err);
				if (!res.headersSent) res.writeHead(500).end("internal error");
				else res.end();
			});
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const port = server.address()?.port ?? 0;
		if (!port) throw new Error("内建预览服务起不来（回环口监听失败）");

		for (const p of [...PREFIXES, capabilityPrefix]) off(host.registerProxy(p, port));
		const task = host.registerBackgroundTask?.({
			id: "preview-server",
			label: "🌐 实时预览",
			status: `127.0.0.1:${port} → /liveserver /md`,
			stop: () => shutdown(),
		});
		if (task) off(() => task.unregister?.());
		try {
			off(host.fs.watch(".", scheduleBump));
		} catch (err) {
			host.log?.("watch 注册失败（自动刷新不可用）:", err?.message ?? err);
		}
		off(
			host.registerAgentTool({
				name: "live_preview",
				description:
					"Open a Live Server-style preview of a workspace file or folder: HTML (relative assets, auto-refresh) is served under /liveserver/, Markdown rendering under /md/. path may be a file or a directory (defaults to the workspace root). Returns a sandboxed preview URL; the browser opens it in a new tab automatically (click the link in the result if the popup was blocked).",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Workspace-relative path, e.g. index.html or docs/a.md; omit to preview the root.",
						},
						open: {
							type: "boolean",
							description: "When false, only return the URL without opening a new tab (default: open automatically).",
						},
					},
				},
				execute: async (_id, params) => {
					const rel = String(params?.path ?? "").replace(/^\/+/, "");
					const seg = rel ? `/${rel.split("/").map(encodeURIComponent).join("/")}` : "/";
					const primary = /\.md$/i.test(rel) ? `/md${seg}` : `/liveserver${seg}`;
					const auto =
						params?.open !== false && settings().autoOpen !== false ? `\n[🔗 已自动在浏览器打开](${primary})` : "";
					const text = `预览地址（隔离沙箱）：\n- HTML：/liveserver${seg}\n- Markdown：/md${seg}\n当前工作区：${host.cwd}${auto}`;
					return { content: [{ type: "text", text }] };
				},
			}),
		);
		host.log?.(`实时预览已启动 127.0.0.1:${port}（/liveserver /md，根=${host.cwd}）`);

		function shutdown() {
			if (deb) clearTimeout(deb);
			deb = null;
			for (const fn of cleanups.splice(0)) {
				try {
					fn();
				} catch {}
			}
			for (const res of state.sse) {
				try {
					res.end();
				} catch {}
			}
			state.sse.clear();
			try {
				server.close();
			} catch {}
		}
		return shutdown;
	},
};
