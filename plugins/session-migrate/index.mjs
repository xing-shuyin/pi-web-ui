import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * 与 SDK `getAgentDir()` 同口径：认 `PI_CODING_AGENT_DIR`（含 `~`），否则 `~/.pi/agent`。
 * 写错库的代价是导入的会话在左栏历史里根本看不到。
 */
function resolveAgentDir() {
	const env = (process.env.PI_CODING_AGENT_DIR || "").trim();
	if (!env) return join(homedir(), ".pi", "agent");
	if (env === "~" || env === "~/" || env === "~\\") return homedir();
	if (env.startsWith("~/") || env.startsWith("~\\")) return join(homedir(), env.slice(2));
	return isAbsolute(env) ? env : resolve(process.cwd(), env);
}

const PI_DIR = join(resolveAgentDir(), "sessions");
const OMP_DIR = join(homedir(), ".omp", "agent", "sessions");

/** 导出只认这两个会话库：插件路由不能变成任意文件下载器（issue #887）。 */
const EXPORT_ROOTS = [PI_DIR, OMP_DIR];
/** 上传导入的硬上限：超过就请用户走磁盘目录导入（`session_migrate_import`）。 */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

const OPENCODE_DB = join(homedir(), ".local", "share", "opencode", "opencode.db");

function grokHome() {
	const env = (process.env.GROK_HOME || "").trim();
	if (!env) return join(homedir(), ".grok");
	return isAbsolute(env) || env.startsWith("/") ? env : join(process.cwd(), env);
}
const grokSessionsDir = () => join(grokHome(), "sessions");

function kimiShareDir() {
	const env = (process.env.KIMI_SHARE_DIR || "").trim();
	return env || join(homedir(), ".kimi");
}

const SOURCES = [
	{ id: "omp", dir: join(homedir(), ".omp", "agent", "sessions"), kind: "pi" },
	{ id: "pi", dir: PI_DIR, kind: "pi" },
	{ id: "claude", dir: join(homedir(), ".claude", "projects"), kind: "claude" },
	{ id: "codex", dir: join(homedir(), ".codex", "sessions"), kind: "codex" },
	{ id: "opencode", dir: OPENCODE_DB, kind: "opencode" },
];

/**
 * 会话目录名必须与 SDK `getDefaultSessionDir` 逐字一致：`--<cwd 去掉前导斜杠、/ \ : 换 ->--`。
 * 否则文件落在 SDK 不扫的目录里，导入完在左栏历史里根本看不到。
 */
function escapeCwd(cwd) {
	return `--${String(cwd || "")
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
}

/** 文件名与 SDK 同格式：`<ISO 时间，: 与 . 换成 ->_<sessionId>.jsonl`。 */
function sessionFileName(id) {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
}

function readLines(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim());
}

function parseJson(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function piMsgText(obj) {
	const msg = obj.message ?? obj;
	if (msg?.role !== "user" && msg?.role !== "assistant") return null;
	const c = msg.content;
	const text =
		typeof c === "string"
			? c
			: Array.isArray(c)
				? c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("")
				: JSON.stringify(c ?? "");
	return { role: msg.role, text };
}

function parsePiFile(file) {
	const raw = readLines(file);
	let session = null;
	let messages = 0;
	let preview = "";
	for (const line of raw) {
		const obj = parseJson(line);
		if (!obj) continue;
		if (obj.type === "session" && !session) {
			session = { id: obj.id, cwd: obj.cwd, timestamp: obj.timestamp };
		} else if (obj.type === "message") {
			messages++;
			if (!preview) {
				const t = piMsgText(obj);
				if (t?.role === "user" && t.text) preview = t.text.slice(0, 120);
			}
		}
	}
	return { session, messages, preview };
}

function blocksText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => (typeof b === "string" ? true : b?.type === "text"))
		.map((b) => (typeof b === "string" ? b : b.text || ""))
		.join("");
}

function parseClaudeFile(file) {
	const raw = readLines(file);
	let sessionId = basename(file, ".jsonl");
	let cwd = "";
	let timestamp = "";
	let messages = 0;
	let preview = "";
	for (const line of raw) {
		const obj = parseJson(line);
		if (!obj) continue;
		if (obj.sessionId) sessionId = obj.sessionId;
		if (!cwd && obj.cwd) cwd = obj.cwd;
		if (!timestamp && obj.timestamp) timestamp = obj.timestamp;
		if ((obj.type === "user" || obj.type === "assistant") && obj.message) {
			messages++;
			if (!preview && (obj.message.role === "user" || obj.type === "user")) {
				const t = blocksText(obj.message.content);
				if (t.trim()) preview = t.slice(0, 120);
			}
		}
	}
	return { session: { id: sessionId, cwd, timestamp }, messages, preview };
}

function parseCodexFile(file) {
	const text = readFileSync(file, "utf8");
	let session = { id: basename(file).replace(/\.[^.]+$/, ""), cwd: "", timestamp: "" };
	let messages = 0;
	let preview = "";
	const count = (role, t) => {
		messages++;
		if (!preview && role === "user" && t?.trim()) preview = t.slice(0, 120);
	};
	if (file.endsWith(".json")) {
		const obj = parseJson(text);
		const s = obj?.session ?? obj ?? {};
		session = { id: s.id || session.id, cwd: s.cwd || s.workdir || "", timestamp: s.timestamp || "" };
		for (const it of obj?.items ?? []) {
			const role = it.role || it.message?.role;
			if (it.type === "message" || (role && it.content)) count(role, blocksText(it.content ?? it.message?.content));
		}
	} else {
		for (const line of text.split("\n").filter((l) => l.trim())) {
			const obj = parseJson(line);
			if (!obj) continue;
			if (!session.cwd && (obj.cwd || obj.workdir)) session.cwd = obj.cwd || obj.workdir;
			if (!session.timestamp && obj.timestamp) session.timestamp = obj.timestamp;
			const role =
				obj.role || obj.message?.role || (obj.type === "user" ? "user" : obj.type === "assistant" ? "assistant" : null);
			if (role === "user" || role === "assistant") count(role, blocksText(obj.content ?? obj.message?.content));
		}
	}
	return { session, messages, preview };
}

const PARSERS = { pi: parsePiFile, claude: parseClaudeFile, codex: parseCodexFile };

function walkFiles(dir, depth) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) {
			if (depth > 0) out.push(...walkFiles(p, depth - 1));
		} else if (/\.jsonl?$/.test(ent.name)) {
			out.push(p);
		}
	}
	return out;
}

function scanSource(src) {
	if (!existsSync(src.dir)) return { items: [], note: `目录不存在：${src.dir}` };
	const depth = src.kind === "codex" ? 4 : 1;
	const parse = PARSERS[src.kind];
	const items = [];
	for (const file of walkFiles(src.dir, depth)) {
		try {
			const { session, messages, preview } = parse(file);
			items.push({
				source: src.id,
				file,
				id: session?.id ?? basename(file).replace(/\.[^.]+$/, ""),
				cwd: session?.cwd ?? "",
				timestamp: session?.timestamp ?? "",
				messages,
				preview,
			});
		} catch (err) {
			items.push({ source: src.id, file, id: basename(file), error: String(err?.message || err) });
		}
	}
	return { items };
}

function grokChunkText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			if (typeof b === "string") return b;
			if (b?.type === "text") return b.text || "";
			if (b?.type === "image") return `[image ${b.url || "inline"}]`;
			return "";
		})
		.join("");
}

function normTs(v) {
	const n = Number(v);
	if (!Number.isFinite(n)) return "";
	return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}

function parseGrokSessionDir(sessDir) {
	const summary = parseJson(
		existsSync(join(sessDir, "summary.json")) ? readFileSync(join(sessDir, "summary.json"), "utf8") : "null",
	);
	const updPath = join(sessDir, "updates.jsonl");
	const seen = new Set();
	const chunks = [];
	if (existsSync(updPath)) {
		for (const line of readFileSync(updPath, "utf8").split("\n")) {
			const ev = parseJson(line.trim());
			if (!ev) continue;
			if (ev.method !== "session/update" && ev.method !== "_x.ai/session/update") continue;
			const meta = ev.params?._meta ?? {};
			if (meta.eventId) {
				if (seen.has(meta.eventId)) continue;
				seen.add(meta.eventId);
			}
			const upd = ev.params?.update ?? {};
			const kind = upd.sessionUpdate ?? "";
			const ts = normTs(meta.agentTimestampMs ?? ev.timestamp);
			const promptKey = String(meta.promptId ?? upd._meta?.promptIndex ?? "");
			if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
				const text = grokChunkText(upd.content);
				if (!text.trim()) continue;
				if (/<system-reminder>/.test(text)) continue;
				chunks.push({ role: kind === "user_message_chunk" ? "user" : "assistant", text, promptKey, ts });
			} else if (kind === "tool_call_update" && (upd.status === "completed" || upd.status === "failed")) {
				const text = upd.content || upd.rawOutput || upd.title;
				if (text?.trim?.())
					chunks.push({
						role: "assistant",
						text: `[tool ${upd.tool || upd.title || "?"}] ${String(text).slice(0, 2000)}`,
						promptKey,
						ts,
					});
			}
		}
	}
	const messages = [];
	for (const c of chunks) {
		const last = messages[messages.length - 1];
		if (last && last.role === c.role && c.role === "user" && last.promptKey === c.promptKey) last.text += c.text;
		else messages.push({ ...c });
	}
	let cwd = summary?.info?.cwd || "";
	if (!cwd) {
		const dotCwd = join(sessDir, "..", ".cwd");
		try {
			if (existsSync(dotCwd)) cwd = readFileSync(dotCwd, "utf8").trim();
		} catch {}
	}
	if (!cwd) {
		try {
			cwd = decodeURIComponent(basename(join(sessDir, "..")));
		} catch {
			cwd = "";
		}
	}
	return {
		session: {
			id: basename(sessDir),
			cwd,
			timestamp: normTs(summary?.updated_at ?? summary?.created_at) || chunks[0]?.ts || "",
		},
		messages,
		summary,
	};
}

function scanGrokBuild() {
	const root = grokSessionsDir();
	if (!existsSync(root)) return { items: [], note: `[grok] 目录不存在：${root}（GROK_HOME 可覆盖，默认 ~/.grok）` };
	const items = [];
	for (const group of readdirSync(root, { withFileTypes: true })) {
		if (!group.isDirectory()) continue;
		if (group.name.startsWith(".")) continue;
		const groupDir = join(root, group.name);
		for (const sess of readdirSync(groupDir, { withFileTypes: true })) {
			if (!sess.isDirectory()) continue;
			const sessDir = join(groupDir, sess.name);
			if (sess.name.startsWith(".") || !existsSync(join(sessDir, "updates.jsonl"))) continue;
			try {
				const { session, messages, summary } = parseGrokSessionDir(sessDir);
				if (summary?.hidden) continue;
				const firstUser = messages.find((m) => m.role === "user");
				items.push({
					source: "grok",
					file: join(sessDir, "updates.jsonl"),
					id: session.id,
					cwd: session.cwd,
					timestamp: session.timestamp,
					messages: messages.length,
					preview: (summary?.generated_title || summary?.session_summary || firstUser?.text || "").slice(0, 120),
				});
			} catch (err) {
				items.push({ source: "grok", file: sessDir, id: sess.name, error: String(err?.message || err) });
			}
		}
	}
	return { items };
}

function convertGrokBuild(updatesFile, targetCwd) {
	const sessDir = join(updatesFile, "..");
	const { session, messages } = parseGrokSessionDir(sessDir);
	const cwd = targetCwd || session.cwd;
	if (!cwd) throw new Error("来源无 cwd，请指定目标 cwd");
	const ts = new Date().toISOString();
	const lines = [JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: ts, cwd })];
	let parentId = null;
	const push = (role, text) => {
		const r = piMsg(role, text, parentId);
		lines.push(r.line);
		parentId = r.id;
	};
	push("user", `[imported-from:grok-build] ${IMPORT_NOTICE}`);
	for (const m of messages) push(m.role, m.text);
	return { lines, skipped: 0, cwd };
}

function kimiContentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) => {
			if (typeof p === "string") return p;
			if (p?.type === "text") return p.text || "";
			return "";
		})
		.join("");
}

function parseKimiSessionDir(sdir) {
	const ctxPath = join(sdir, "context.jsonl");
	const wirePath = join(sdir, "wire.jsonl");
	const state = parseJson(
		existsSync(join(sdir, "state.json")) ? readFileSync(join(sdir, "state.json"), "utf8") : "null",
	);
	let firstInput = "";
	let ts = "";
	if (existsSync(wirePath)) {
		for (const line of readFileSync(wirePath, "utf8").split("\n")) {
			const rec = parseJson(line.trim());
			const inner = rec?.record ?? rec;
			if (!inner || typeof inner !== "object") continue;
			if (!ts && typeof rec?.timestamp === "number") ts = new Date(rec.timestamp * 1000).toISOString();
			const type = inner.type ?? "";
			if (!firstInput && /TurnBegin/.test(type) && inner.user_input?.trim?.()) firstInput = inner.user_input;
			if (firstInput) break;
		}
	}
	const messages = [];
	for (const line of readFileSync(ctxPath, "utf8").split("\n")) {
		const msg = parseJson(line.trim());
		if (!msg || typeof msg !== "object") continue;
		const role = msg.role;
		if (typeof role !== "string" || role.startsWith("_")) continue;
		if (msg.is_checkpoint || msg.system_reminder) continue;
		if (role === "tool") {
			const t = kimiContentText(msg.content);
			messages.push({ role: "user", text: `[tool result] ${t.slice(0, 2000)}` });
			continue;
		}
		if (role !== "user" && role !== "assistant") continue;
		const text = kimiContentText(msg.content);
		const tools = (msg.tool_calls ?? []).map(
			(t) => `${t?.function?.name || "tool"}(${(t?.function?.arguments || "").slice(0, 200)})`,
		);
		const combined = [text, ...tools].filter(Boolean).join("\n");
		if (!combined.trim()) continue;
		messages.push({ role, text: combined });
	}
	return {
		messages,
		preview: (firstInput || messages.find((m) => m.role === "user")?.text || state?.custom_title || "").slice(0, 120),
		timestamp: ts,
		state,
	};
}

function scanKimi() {
	const share = kimiShareDir();
	const idxPath = join(share, "kimi.json");
	if (!existsSync(idxPath))
		return { items: [], note: `[kimi] 索引不存在：${idxPath}（KIMI_SHARE_DIR 可覆盖，默认 ~/.kimi）` };
	let meta;
	try {
		meta = JSON.parse(readFileSync(idxPath, "utf8"));
	} catch (err) {
		return { items: [], note: `[kimi] 索引解析失败：${String(err?.message || err)}` };
	}
	const items = [];
	const crypto = require("node:crypto");
	for (const wd of meta?.work_dirs ?? []) {
		const bucket = crypto.createHash("md5").update(wd.path).digest("hex");
		const bucketDir = join(share, "sessions", bucket);
		if (!existsSync(bucketDir)) continue;
		for (const sid of readdirSync(bucketDir)) {
			const sdir = join(bucketDir, sid);
			if (!existsSync(join(sdir, "context.jsonl"))) continue;
			try {
				const { messages, preview, timestamp, state } = parseKimiSessionDir(sdir);
				if (state?.archived) continue;
				items.push({
					source: "kimi",
					file: join(sdir, "context.jsonl"),
					id: sid,
					cwd: wd.path || "",
					timestamp,
					messages: messages.length,
					preview,
				});
			} catch (err) {
				items.push({ source: "kimi", file: sdir, id: sid, error: String(err?.message || err) });
			}
		}
	}
	return { items };
}

function convertKimi(contextFile, targetCwd) {
	const { messages } = parseKimiSessionDir(join(contextFile, ".."));
	if (!targetCwd) throw new Error("kimi 来源需指定目标 cwd（不知其工作区时填当前项目路径）");
	const ts = new Date().toISOString();
	const lines = [JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: ts, cwd: targetCwd })];
	let parentId = null;
	const push = (role, text) => {
		const r = piMsg(role, text, parentId);
		lines.push(r.line);
		parentId = r.id;
	};
	push("user", `[imported-from:kimi] ${IMPORT_NOTICE}`);
	for (const m of messages) push(m.role, m.text);
	return { lines, skipped: 0, cwd: targetCwd };
}

function scanOpencode() {
	try {
		if (!existsSync(OPENCODE_DB)) return { items: [], note: `[opencode] 目录不存在：${OPENCODE_DB}` };
		let DatabaseSync;
		try {
			({ DatabaseSync } = require("node:sqlite"));
		} catch {
			return { items: [], note: "[opencode] 需要 node:sqlite（Node ≥ 22.5），当前运行时不支持" };
		}
		const db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
		try {
			const sessions = db.prepare("SELECT id, directory, title, time_created FROM session").all();
			const items = sessions.map((s) => {
				const n = db.prepare("SELECT COUNT(*) AS c FROM message WHERE session_id = ?").get(s.id)?.c;
				const first = db
					.prepare(
						"SELECT p.data FROM part p JOIN message m ON m.id = p.message_id " +
							"WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user' " +
							"AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created LIMIT 1",
					)
					.get(s.id);
				let preview = s.title || "";
				try {
					const t = JSON.parse(first?.data ?? "null")?.text;
					if (t) preview = t.slice(0, 120);
				} catch {}
				return {
					source: "opencode",
					file: `opencode:${s.id}`,
					id: s.id,
					cwd: s.directory || "",
					timestamp: s.time_created ? new Date(s.time_created).toISOString() : "",
					messages: n ?? 0,
					preview,
				};
			});
			return { items };
		} finally {
			db.close();
		}
	} catch (err) {
		return { items: [], note: `[opencode] 扫描失败：${String(err?.message || err)}` };
	}
}

function convertOpencode(sessionId) {
	const { DatabaseSync } = require("node:sqlite");
	const db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
	try {
		const s = db.prepare("SELECT id, directory FROM session WHERE id = ?").get(sessionId);
		if (!s) throw new Error(`opencode 会话不存在：${sessionId}`);
		const ts = new Date().toISOString();
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: ts, cwd: s.directory || "" }),
		];
		let parentId = null;
		let skipped = 0;
		const push = (role, text) => {
			const r = piMsg(role, text, parentId);
			lines.push(r.line);
			parentId = r.id;
		};
		push("user", `[imported-from:opencode] ${IMPORT_NOTICE}`);
		const msgs = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created").all(sessionId);
		for (const m of msgs) {
			let role;
			try {
				role = JSON.parse(m.data)?.role;
			} catch {
				skipped++;
				continue;
			}
			if (role !== "user" && role !== "assistant") {
				skipped++;
				continue;
			}
			const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created").all(m.id);
			const texts = [];
			for (const p of parts) {
				const d = parseJson(p.data);
				if (d?.type === "text" && d.text?.trim()) texts.push(d.text);
				else if (d && d.type !== "step-start" && d.type !== "step-finish") skipped++;
			}
			if (!texts.length) {
				skipped++;
				continue;
			}
			push(role, texts.join("\n"));
		}
		return { lines, skipped, cwd: s.directory || "" };
	} finally {
		db.close();
	}
}

function scanSources() {
	const out = { notes: [] };
	for (const src of SOURCES) {
		if (src.kind === "opencode") {
			const r = scanOpencode();
			out.opencode = r.items;
			if (r.note) out.notes.push(r.note);
			continue;
		}
		const r = scanSource(src);
		out[src.id] = r.items;
		if (r.note) out.notes.push(`[${src.id}] ${r.note}`);
	}
	const grok = scanGrokBuild();
	out.grok = grok.items;
	if (grok.note) out.notes.push(grok.note);
	const kimi = scanKimi();
	out.kimi = kimi.items;
	if (kimi.note) out.notes.push(kimi.note);
	return out;
}

export function normalizeOmp(lines) {
	return lines.map((line) => {
		const obj = parseJson(line);
		if (!obj) return line;
		if (obj.type === "model_change" && typeof obj.model === "string" && obj.model.includes("/")) {
			const i = obj.model.indexOf("/");
			obj.provider = obj.model.slice(0, i);
			obj.modelId = obj.model.slice(i + 1);
			delete obj.model;
		}
		if (obj.type === "message" && obj.attribution) delete obj.attribution;
		return JSON.stringify(obj);
	});
}

function piMsg(role, text, parentId) {
	const id = randomUUID().slice(0, 8);
	const ts = Date.now();
	return {
		line: JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: new Date(ts).toISOString(),
			message: { role, content: [{ type: "text", text }], timestamp: ts },
		}),
		id,
	};
}

const IMPORT_NOTICE =
	"（本会话由 session-migrate 插件从外部智能体导入：超出现有工具范围的工具调用记录可能已省略，缺失的上下文不代表当前工具可用。）";

export function convertToPi(source, file) {
	const raw = source === "codex" && file.endsWith(".json") ? [readFileSync(file, "utf8")] : readLines(file);
	const sessionId = randomUUID();
	const first = parseJson(raw[0]);
	const cwd = (source === "claude" ? first?.cwd : (first?.session?.cwd ?? first?.session?.workdir)) || first?.cwd || "";
	const ts = new Date().toISOString();
	const lines = [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: ts, cwd })];
	let parentId = null;
	let skipped = 0;
	const pushNotice = () => {
		const r = piMsg("user", `[imported-from:${source}] ${IMPORT_NOTICE}`, parentId);
		lines.push(r.line);
		parentId = r.id;
	};
	pushNotice();
	const push = (role, text) => {
		const r = piMsg(role, text, parentId);
		lines.push(r.line);
		parentId = r.id;
	};

	if (source === "claude") {
		for (const line of raw) {
			const obj = parseJson(line);
			if (!obj || !obj.message || (obj.type !== "user" && obj.type !== "assistant")) {
				skipped++;
				continue;
			}
			const role = obj.message.role === "assistant" ? "assistant" : "user";
			const text = blocksText(obj.message.content);
			if (!text.trim()) {
				skipped++;
				continue;
			}
			push(role, text);
		}
	} else {
		let items = [];
		if (file.endsWith(".json")) {
			items = parseJson(raw[0])?.items ?? [];
		} else {
			for (const line of raw) {
				const obj = parseJson(line);
				if (obj) items.push(obj.payload ?? obj);
			}
		}
		for (const it of items) {
			const role = it.role || it.message?.role;
			if (role !== "user" && role !== "assistant") {
				skipped++;
				continue;
			}
			const text = blocksText(it.content ?? it.message?.content);
			if (!text.trim()) {
				skipped++;
				continue;
			}
			push(role, text);
		}
	}
	return { lines, skipped, cwd };
}

function importSessions(files, targetCwd) {
	const results = [];
	for (const file of files) {
		try {
			const norm = (p) => String(p || "").replace(/\\/g, "/");
			const inGrok = norm(file).startsWith(norm(grokSessionsDir()));
			const inKimi = norm(file).startsWith(norm(join(kimiShareDir(), "sessions")));
			const src = file.startsWith("opencode:")
				? "opencode"
				: inGrok
					? "grok"
					: inKimi
						? "kimi"
						: (SOURCES.find((s) => file.startsWith(s.dir))?.id ?? "pi");
			let out;
			let cwd;
			if (src === "opencode" || file.startsWith("opencode:")) {
				const conv = convertOpencode(file.replace(/^opencode:/, ""));
				out = conv.lines;
				cwd = targetCwd || conv.cwd;
				if (!cwd) {
					results.push({ file, ok: false, error: "来源无 cwd，请指定目标 cwd" });
					continue;
				}
				out[0] = JSON.stringify({ ...JSON.parse(out[0]), cwd });
				if (conv.skipped) out.push(piMsg("user", `（导入时跳过 ${conv.skipped} 条非文本记录。）`, null).line);
			} else if (src === "grok") {
				const conv = convertGrokBuild(file, targetCwd);
				out = conv.lines;
				cwd = conv.cwd;
			} else if (src === "kimi") {
				const conv = convertKimi(file, targetCwd);
				out = conv.lines;
				cwd = conv.cwd;
			} else if (src === "claude" || src === "codex") {
				const conv = convertToPi(src, file);
				out = conv.lines;
				cwd = targetCwd || conv.cwd;
				if (!cwd) {
					results.push({ file, ok: false, error: "来源无 cwd，请指定目标 cwd" });
					continue;
				}
				out[0] = JSON.stringify({ ...JSON.parse(out[0]), cwd });
				if (conv.skipped) out.push(piMsg("user", `（导入时跳过 ${conv.skipped} 条非文本记录。）`, null).line);
			} else {
				const raw = readLines(file);
				const head = parseJson(raw[0]);
				if (head?.type !== "session" || !head?.id) {
					results.push({ file, ok: false, error: "缺少 session 头" });
					continue;
				}
				cwd = targetCwd || head.cwd;
				if (!cwd) {
					results.push({ file, ok: false, error: "来源无 cwd，请指定目标 cwd" });
					continue;
				}
				out = normalizeOmp(raw);
				out[0] = JSON.stringify({ ...JSON.parse(out[0]), cwd, importedFrom: "pi-file" });
				const noticeIdx = out.findIndex((l, i) => i > 0 && parseJson(l)?.type === "message");
				if (noticeIdx > 0) {
					const firstMsg = parseJson(out[noticeIdx]);
					const textPart = firstMsg?.message?.content?.find?.((c) => c?.type === "text");
					if (textPart && typeof textPart.text === "string") {
						textPart.text = `[imported-from:pi-file] ${IMPORT_NOTICE}\n\n${textPart.text}`;
						out[noticeIdx] = JSON.stringify(firstMsg);
					}
				}
			}
			const sessionId = JSON.parse(out[0]).id;
			const destDir = join(PI_DIR, escapeCwd(cwd));
			const base = file.startsWith("opencode:")
				? sessionId
				: src === "grok"
					? basename(join(file, ".."))
					: src === "kimi"
						? basename(join(file, ".."))
						: basename(file).replace(/\.[^.]+$/, "");
			const dest = join(destDir, `${base || sessionId}.jsonl`);
			if (existsSync(dest)) {
				results.push({ file, ok: false, skipped: true, error: "目标已存在，跳过" });
				continue;
			}
			mkdirSync(destDir, { recursive: true });
			writeFileSync(dest, out.join("\n") + "\n", "utf8");
			results.push({ file, ok: true, dest });
		} catch (err) {
			results.push({ file, ok: false, error: String(err?.message || err) });
		}
	}
	return results;
}

export { scanSources, importSessions };

// ---------------------------------------------------------------------------
// issue #887：导出会话 / 导入上传的 .jsonl
// ---------------------------------------------------------------------------

function escapeRe(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
}

function isInsideRoot(root, target) {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 只放行会话库里的 .jsonl/.json，否则返回 null（路由层不做其它文件服务）。
 * @param {unknown} file
 * @param {string[]} [roots]
 * @returns {string | null}
 */
export function exportableSessionPath(file, roots = EXPORT_ROOTS) {
	const raw = String(file || "").trim();
	if (!raw) return null;
	const abs = resolve(raw);
	if (!/\.(jsonl|json)$/i.test(abs)) return null;
	let real;
	try {
		// 软链接可能把会话目录里的文件名指向外部，先解实路径再判越界
		real = realpathSync(abs);
	} catch {
		return null;
	}
	const realRoots = roots.map((root) => {
		try {
			return realpathSync(root);
		} catch {
			return resolve(root);
		}
	});
	if (!realRoots.some((root) => isInsideRoot(root, real))) return null;
	try {
		if (!statSync(real).isFile()) return null;
	} catch {
		return null;
	}
	return abs;
}

/**
 * 按 session id 在会话库里找回已存在的文件（pi 文件名可能是 `<ts>_<id>.jsonl` 或 `<id>.jsonl`）。
 * @param {string} id
 * @param {string} [root]
 * @returns {string[]}
 */
export function findSessionsById(id, root = PI_DIR) {
	const needle = new RegExp(`(^|_)${escapeRe(id)}\\.jsonl$`, "i");
	const hits = [];
	let dirs = [];
	try {
		dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
	} catch {
		return hits;
	}
	for (const d of dirs) {
		const dir = join(root, d.name);
		let files = [];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of files) if (needle.test(f)) hits.push(join(dir, f));
	}
	return hits;
}

/**
 * 首行必须是 pi 会话头；其余行宽容保留（历史版本可能有插件私有事件）。
 * @param {unknown} text
 * @returns {any}
 */
export function parsePiSessionText(text) {
	const raw = String(text ?? "").replace(/^\uFEFF/, "");
	const lines = raw.split(/\r?\n/).filter((l) => l.trim());
	if (lines.length === 0) return { ok: false, error: "空文件" };
	const header = parseJson(lines[0]);
	if (header?.type !== "session" || typeof header.id !== "string" || !header.id.trim()) {
		return { ok: false, error: '第一行不是 pi 会话头（需要 type:"session" 与 id）' };
	}
	let bad = 0;
	let messages = 0;
	for (let i = 1; i < lines.length; i++) {
		const obj = parseJson(lines[i]);
		if (!obj) bad++;
		else if (obj.type === "message") messages++;
	}
	return { ok: true, lines, header, bad, messages };
}

/**
 * 导入一份 pi 会话文本。mode：`copy` 换 id 另存 / `overwrite` 覆盖同 id 的旧文件 / 缺省先问。
 * 重名时返回 `{ ok:false, duplicate:true, existing }`，由前端弹「覆盖 / 另存 / 取消」。
 * @param {{ text?: unknown, targetCwd?: string, mode?: string, root?: string }} [opts]
 * @returns {any}
 */
export function importSessionText({ text, targetCwd, mode, root = PI_DIR } = {}) {
	const parsed = parsePiSessionText(text);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const { header, lines } = parsed;
	const cwd = String(targetCwd || "").trim() || String(header.cwd || "").trim();
	if (!cwd) return { ok: false, error: "会话头没有 cwd，请指定目标 cwd" };

	const existing = findSessionsById(header.id, root);
	const wantCopy = mode === "copy";
	const wantOverwrite = mode === "overwrite";
	if (existing.length > 0 && !wantCopy && !wantOverwrite) {
		return { ok: false, duplicate: true, sessionId: header.id, cwd, existing };
	}

	const out = [...lines];
	let id = header.id;
	if (wantCopy) {
		id = randomUUID();
		out[0] = JSON.stringify({ ...header, id, cwd });
	} else {
		out[0] = JSON.stringify({ ...header, cwd });
	}

	// 覆盖已有同 id 文件时就地写回原路径（不另造文件名，不产生平行会话）
	const dest = wantOverwrite && existing.length > 0 ? existing[0] : join(root, escapeCwd(cwd), sessionFileName(id));
	try {
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, `${out.join("\n")}\n`, "utf8");
	} catch (err) {
		return { ok: false, error: String(err?.message || err) };
	}
	return {
		ok: true,
		sessionId: id,
		cwd,
		dest,
		messages: parsed.messages,
		badLines: parsed.bad,
		mode: wantCopy ? "copy" : wantOverwrite ? "overwrite" : "new",
	};
}

function readImportPayload(req) {
	const body = req.body && typeof req.body === "object" ? req.body : null;
	if (body && typeof body.text === "string") {
		return Promise.resolve({ text: body.text, targetCwd: body.targetCwd, mode: body.mode });
	}
	if (body) return Promise.resolve({ text: "", targetCwd: body.targetCwd, mode: body.mode });
	// 非 JSON 请求体（application/octet-stream）：直接流式收文本，突破 express.json 的 10MB 上限
	const header = (key) => {
		const v = req.headers?.[key];
		return typeof v === "string" && v ? safeDecode(v) : undefined;
	};
	return new Promise((done, fail) => {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			if (aborted) return;
			size += chunk.length;
			if (size > MAX_IMPORT_BYTES) {
				aborted = true;
				fail(new Error(`文件超过 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB 上限`));
				return;
			}
			chunks.push(Buffer.from(chunk));
		});
		req.on("end", () => {
			if (aborted) return;
			done({
				text: Buffer.concat(chunks).toString("utf8"),
				targetCwd: header("x-target-cwd"),
				mode: header("x-session-mode"),
			});
		});
		req.on("error", (err) => fail(err));
	});
}

function safeDecode(v) {
	try {
		return decodeURIComponent(v);
	} catch {
		return v;
	}
}

export default {
	activate(host) {
		host.registerAgentTool({
			name: "session_migrate_scan",
			label: "扫描可迁移会话",
			description:
				"Scan omp/pi/claude/codex session stores for migratable sessions (read-only). No network, no writes.",
			promptSnippet: "list omp/pi/claude/codex sessions with id/cwd/count/preview",
			parameters: { type: "object", properties: {} },
			async execute() {
				return JSON.stringify(scanSources(), null, 2);
			},
		});
		host.registerAgentTool({
			name: "session_migrate_import",
			label: "导入会话到 pi",
			description:
				"Import session files into ~/.pi/agent/sessions (omp/pi copied with normalization, claude/codex converted to pi v3). Skips existing ids, never touches sources.",
			promptSnippet: "import files (targetCwd optional redirect, required when source lacks cwd)",
			parameters: {
				type: "object",
				properties: {
					files: { type: "array", items: { type: "string" } },
					targetCwd: { type: "string" },
				},
				required: ["files"],
			},
			async execute(_id, params) {
				return JSON.stringify(importSessions(params.files ?? [], params.targetCwd), null, 2);
			},
		});
		host.registerAgentTool({
			name: "session_migrate_export",
			label: "导出会话文件",
			description:
				"Copy a pi/omp session .jsonl into the workspace so the user can download or archive it. The source store is only read, never modified.",
			promptSnippet: "copy a session jsonl into the workspace for backup",
			parameters: {
				type: "object",
				properties: {
					file: { type: "string" },
					dest: { type: "string" },
				},
				required: ["file"],
			},
			async execute(_id, params) {
				const abs = exportableSessionPath(params.file);
				if (!abs) return JSON.stringify({ ok: false, error: "只能导出 pi / omp 会话库里的 .jsonl 文件" });
				const dest = host.resolveInWorkspace(params.dest || `session-${basename(abs)}`);
				mkdirSync(dirname(dest), { recursive: true });
				writeFileSync(dest, readFileSync(abs));
				return JSON.stringify({ ok: true, from: abs, dest });
			},
		});
		host.registerAgentTool({
			name: "session_migrate_from_jsonl",
			label: "从 JSONL 导入会话",
			description:
				"Import one pi session .jsonl given as text (e.g. exported from another machine). mode omitted returns duplicate info when the session id exists; copy imports with a fresh id; overwrite replaces the existing file.",
			promptSnippet: "import a pasted/uploaded pi session jsonl (duplicate modes)",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string" },
					targetCwd: { type: "string" },
					mode: { type: "string" },
				},
				required: ["text"],
			},
			async execute(_id, params) {
				return JSON.stringify(importSessionText(params ?? {}), null, 2);
			},
		});
		host.route("GET", "/scan", (_req, res) => res.json(scanSources()));
		host.route("POST", "/import", (req, res) => {
			const body = req.body ?? {};
			res.json({ results: importSessions(body.files ?? [], body.targetCwd) });
		});
		// issue #887：导出单个会话文件（浏览器直接下载）
		host.route("GET", "/export", (req, res) => {
			const abs = exportableSessionPath(req.query?.file);
			if (!abs) {
				res.status(400).json({ ok: false, error: "只能导出 pi / omp 会话库里的 .jsonl 文件" });
				return;
			}
			const name = basename(abs).replace(/["\\\r\n]/g, "");
			res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
			res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
			res.setHeader("Cache-Control", "no-store");
			res.end(readFileSync(abs));
		});
		// issue #887：导入用户上传的 .jsonl（JSON 小文件 / octet-stream 大文件两种投递）
		host.route("POST", "/import-file", async (req, res) => {
			try {
				const payload = await readImportPayload(req);
				const result = importSessionText(payload);
				res.status(result.ok ? 200 : result.duplicate ? 409 : 400).json(result);
			} catch (err) {
				res.status(400).json({ ok: false, error: String(err?.message || err) });
			}
		});
	},
};
