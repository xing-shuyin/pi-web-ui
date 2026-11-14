import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { esc } from "../../plugin-sdk/client-utils.mjs";

const CONFIG_FILE = "config.json";
const BODY_LIMIT = 16000;
const SEARCH_SCAN = 1000;

const DEFAULT_CONFIG = {
	imap: { host: "", port: 993, tls: true, user: "", pass: "" },
	smtp: {
		host: "",
		port: 465,
		tls: true,
		user: "",
		pass: "",
		from: "",
	},
	pollSec: 60,
	notifyEnabled: true,
	transModel: "",
};

async function loadConfig(dir) {
	const raw = join(dir, CONFIG_FILE);
	if (!existsSync(raw)) return structuredClone(DEFAULT_CONFIG);
	try {
		const parsed = JSON.parse(await readFile(raw, "utf8"));
		return {
			...structuredClone(DEFAULT_CONFIG),
			...parsed,
			imap: { ...DEFAULT_CONFIG.imap, ...parsed.imap },
			smtp: { ...DEFAULT_CONFIG.smtp, ...parsed.smtp },
		};
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

async function saveConfig(dir, cfg) {
	await writeFile(join(dir, CONFIG_FILE), JSON.stringify(cfg, null, "\t"), "utf8");
}

function resolveNpmCli() {
	try {
		return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
	} catch {
		return null;
	}
}

export default {
	activate(host) {
		const st = {
			config: null,
			client: null,
			chain: Promise.resolve(),
			pollTimer: null,
			pollBusy: false,
			lastUnseenUids: new Set(),
			firstPollDone: false,
			deps: { imapflow: null, mailparser: null, nodemailer: null },
			depsOk: false,
			depsInstalling: false,
			status: "未配置",
			lastCheckAt: 0,
			unseenTotal: 0,
			toolUnregister: null,
			bgTask: null,
			availableModels: [],
		};

		const sec = host.secrets;
		let secretsDegradedWarned = false;

		function storeSecret(name, value) {
			if (!sec?.set || !value) return false;
			try {
				sec.set(name, String(value));
				return sec.get?.(name) === String(value);
			} catch (err) {
				host.log(`机密写入失败 ${name}:`, err?.message ?? err);
				return false;
			}
		}

		function warnSecretsDegraded() {
			if (secretsDegradedWarned) return;
			secretsDegradedWarned = true;
			host.log("加密存储不可用，密码以明文保存在 config.json");
			host.notify(
				"warning",
				"📬 邮件插件：加密存储不可用，密码已以明文保存在 config.json（功能不受影响）",
				"Webmail: encrypted storage unavailable — the password was saved as plain text in config.json (functionality unaffected)",
			);
		}

		async function loadConfigSecure() {
			const cfg = await loadConfig(host.dir);
			if (sec?.set) {
				let migrated = false;
				for (const [sect, secretName] of [
					["imap", "imap_pass"],
					["smtp", "smtp_pass"],
				]) {
					const legacy = cfg?.[sect]?.pass;
					if (!legacy) continue;
					if (storeSecret(secretName, legacy)) {
						cfg[sect].pass = "";
						migrated = true;
					} else {
						warnSecretsDegraded();
					}
				}
				if (migrated) {
					try {
						await saveConfig(host.dir, cfg);
					} catch {}
					host.log("已将明文密码迁移到加密存储");
				}
			}
			return rehydrate(cfg);
		}

		function rehydrate(cfg) {
			if (!sec?.get || !cfg) return cfg;
			const ip = sec.get("imap_pass");
			const sp = sec.get("smtp_pass");
			if (ip !== undefined && !cfg.imap.pass) cfg.imap.pass = ip;
			if (sp !== undefined && !cfg.smtp.pass) cfg.smtp.pass = sp;
			return cfg;
		}

		function publicState() {
			const c = st.config;
			return {
				configured: Boolean(c?.imap?.host && c?.imap?.user),
				depsOk: st.depsOk,
				depsInstalling: st.depsInstalling,
				status: st.status,
				unseen: st.unseenTotal,
				lastCheckAt: st.lastCheckAt,
				notifyEnabled: c?.notifyEnabled !== false && Boolean(c?.imap?.host),
				config: {
					imap: {
						host: c?.imap?.host ?? "",
						port: c?.imap?.port ?? 993,
						tls: c?.imap?.tls !== false,
						user: c?.imap?.user ?? "",
						hasPass: Boolean(c?.imap?.pass),
					},
					smtp: {
						host: c?.smtp?.host ?? "",
						port: c?.smtp?.port ?? 465,
						tls: c?.smtp?.tls !== false,
						user: c?.smtp?.user ?? "",
						from: c?.smtp?.from ?? "",
						hasPass: Boolean(c?.smtp?.pass),
					},
					pollSec: c?.pollSec ?? 60,
					notifyEnabled: c?.notifyEnabled !== false,
					transModel: c?.transModel ?? "",
				},
				models: st.availableModels || [],
			};
		}
		function broadcastState() {
			host.broadcast({ kind: "state", state: publicState() });
		}

		async function applyConfig(next) {
			next.imap.pass = next.imap.pass || st.config?.imap?.pass || sec?.get?.("imap_pass") || "";
			next.smtp.pass = next.smtp.pass || st.config?.smtp?.pass || sec?.get?.("smtp_pass") || "";
			const onDisk = structuredClone(next);
			let degraded = false;
			for (const [sect, secretName] of [
				["imap", "imap_pass"],
				["smtp", "smtp_pass"],
			]) {
				if (!next[sect].pass) continue;
				if (storeSecret(secretName, next[sect].pass)) onDisk[sect].pass = "";
				else degraded = true;
			}
			if (degraded && sec?.set) warnSecretsDegraded();
			st.config = next;
			await saveConfig(host.dir, onDisk);
			if (!st.depsOk && next.imap?.host) installDeps(true);
			restartPoller();
			await refreshAiTools();
			broadcastState();
		}

		async function loadDeps() {
			for (const name of ["imapflow", "mailparser", "nodemailer"]) {
				try {
					st.deps[name] = await import(name);
				} catch (err) {
					host.log(`依赖 ${name} 未就绪:`, err?.message ?? err);
					st.deps[name] = null;
				}
			}
			st.depsOk = ["imapflow", "mailparser"].every((n) => st.deps[n]);
			if (!st.depsOk || !st.deps.nodemailer) host.log("提示：在设置里点「安装依赖」完成安装");
			return st.depsOk;
		}

		function installDeps(auto = false) {
			if (st.depsInstalling) return;
			st.depsInstalling = true;
			host.log(`installing deps: imapflow / mailparser / nodemailer${auto ? " (auto)" : ""}`);
			if (!auto) host.notify("info", "📬 邮件插件：开始安装依赖…");
			host.notify("info", "📬 邮件插件：开始安装依赖（imapflow / mailparser / nodemailer）…");
			const pkgs = ["imapflow@latest", "mailparser@latest", "nodemailer@latest"];
			const npmCli = resolveNpmCli();
			const isWin = process.platform === "win32";
			const child = npmCli
				? spawn(process.execPath, [npmCli, "--prefix", host.dir, "install", ...pkgs, "--no-audit", "--no-fund"], {
						stdio: "ignore",
					})
				: isWin
					? spawn(
							process.env.ComSpec || "cmd.exe",
							["/d", "/s", "/c", "npm.cmd", "--prefix", host.dir, "install", ...pkgs, "--no-audit", "--no-fund"],
							{
								stdio: "ignore",
								windowsHide: true,
							},
						)
					: spawn("npm", ["--prefix", host.dir, "install", ...pkgs, "--no-audit", "--no-fund"], {
							stdio: "ignore",
						});
			st.installChild = child;
			child.on("error", (err) => finish(false, err.message));
			child.on("exit", (code) => finish(code === 0, `npm exit ${code}`));
			let done = false;
			async function finish(ok, why) {
				if (done) return;
				done = true;
				st.depsInstalling = false;
				if (st.installChild === child) st.installChild = null;
				if (ok) {
					await loadDeps();
					restartPoller();
					await refreshAiTools();
				}
				host.notify(
					ok ? "success" : "error",
					ok
						? "📬 邮件插件依赖安装完成"
						: `📬 邮件插件依赖安装失败（${why}）——请在插件目录手动执行 npm install，或在设置面板重试「安装依赖」`,
				);
				broadcastState();
			}
		}

		function serialized(fn) {
			if (st.dead) return Promise.reject(new Error("插件已停用"));
			const run = st.chain.then(
				() => {
					if (st.dead) throw new Error("插件已停用");
					return fn();
				},
				() => {
					if (st.dead) throw new Error("插件已停用");
					return fn();
				},
			);
			st.chain = run.then(
				() => {},
				() => {},
			);
			return run;
		}

		function dropClient(why) {
			const c = st.client;
			st.client = null;
			if (c) {
				try {
					c.close();
				} catch {}
			}
			if (why) host.log("连接断开:", why);
		}

		async function ensureClient() {
			if (st.dead) throw new Error("插件已停用");
			const c = st.config?.imap;
			if (!st.deps.imapflow) throw new Error("依赖未安装：请在设置面板点「安装依赖」");
			if (!c?.host || !c?.user) throw new Error("尚未配置 IMAP 账号");
			if (st.client?.usable) return st.client;
			dropClient();
			const { ImapFlow } = st.deps.imapflow;
			const client = new ImapFlow({
				host: c.host,
				port: Number(c.port) || 993,
				secure: c.tls !== false,
				auth: { user: c.user, pass: c.pass ?? "" },
				logger: false,
			});
			client.on("error", (err) => dropClient(err?.message));
			await client.connect();
			if (st.dead) {
				try {
					client.close();
				} catch {}
				throw new Error("插件已停用");
			}
			st.client = client;
			st.status = "已连接";
			return client;
		}

		async function withMailbox(folder, fn) {
			const client = await ensureClient();
			const lock = await client.getMailboxLock(folder || "INBOX");
			try {
				return await fn(client);
			} finally {
				lock.release();
			}
		}

		function envFrom(envelope) {
			const addr = envelope?.from?.[0];
			return addr ? addr.address : "";
		}
		function envName(envelope) {
			const addr = envelope?.from?.[0];
			return addr?.name || "";
		}
		function summarize(msg) {
			return {
				uid: msg.uid,
				from: envFrom(msg.envelope),
				fromName: envName(msg.envelope),
				to: (msg.envelope?.to ?? []).map((a) => a.address).join(", "),
				subject: msg.envelope?.subject || "(无主题)",
				date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : "",
				seen: Boolean(msg.flags?.has("\\Seen")),
				size: msg.size ?? 0,
			};
		}

		async function listMails({ folder = "INBOX", limit = 30, unseenOnly = false } = {}) {
			return withMailbox(folder, async (client) => {
				const box = client.mailbox;
				const total = box?.exists ?? 0;
				if (total === 0) return [];
				const start = Math.max(1, total - Math.min(Number(limit) || 30, 200) + 1);
				const out = [];
				const range = `${start}:*`;
				for await (const msg of client.fetch(range, {
					envelope: true,
					flags: true,
					size: true,
				})) {
					if (unseenOnly && msg.flags?.has("\\Seen")) continue;
					out.push(summarize(msg));
				}
				out.sort((a, b) => new Date(b.date) - new Date(a.date));
				return out;
			});
		}

		async function searchMails({ query, folder = "INBOX", limit = 20 } = {}) {
			const q = String(query ?? "")
				.trim()
				.toLowerCase();
			if (!q) return [];
			const pool = await listMails({ folder, limit: SEARCH_SCAN });
			return pool
				.filter((m) => [m.subject, m.from, m.fromName, m.to].some((s) => String(s).toLowerCase().includes(q)))
				.slice(0, Math.min(Number(limit) || 20, 50));
		}

		function cleanMailPlainText(raw) {
			return String(raw ?? "")
				.replace(/\r\n/g, "\n")
				.replace(/&nbsp;/gi, " ")
				.replace(/&amp;/gi, "&")
				.replace(/&lt;/gi, "<")
				.replace(/&gt;/gi, ">")
				.replace(/&quot;/gi, '"')
				.replace(/&#39;|&apos;/gi, "'")
				.replace(/&copy;/gi, "©")
				.replace(/&ndash;/gi, "–")
				.replace(/&mdash;/gi, "—")
				.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
				.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
				.replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, "\n")
				.replace(/(?:^|\n)[ \t]*(?:[a-z0-9_.*#\-:>+, \t]+\n)*[ \t]*[a-z0-9_.*#\-:>+, \t]+\{[^{}]*\}/gi, "\n")
				.replace(/[ \t]+\n/g, "\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
		}

		async function readMail({ folder = "INBOX", uid } = {}) {
			if (!uid) throw new Error("缺少 uid");
			return withMailbox(folder, async (client) => {
				const msg = await client.fetchOne(String(uid), { envelope: true, flags: true, source: true }, { uid: true });
				if (!msg || !msg.source) throw new Error(`未找到 uid=${uid}`);
				const meta = summarize(msg);
				const raw = msg.source;
				const { simpleParser } = st.deps.mailparser;
				const parsed = await simpleParser(raw);
				const rawText =
					parsed.text ||
					String(parsed.html ?? "")
						.replace(/<style[\s\S]*?<\/style>/gi, "")
						.replace(/<script[\s\S]*?<\/script>/gi, "")
						.replace(/<br\s*\/?>/gi, "\n")
						.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
						.replace(/<[^>]+>/g, " ");
				const text = cleanMailPlainText(rawText);
				let safeHtml = "";
				if (parsed.html) {
					safeHtml = String(parsed.html)
						.replace(/<script[\s\S]*?<\/script>/gi, "")
						.replace(/\son\w+\s*=\s*(['"])[\s\S]*?\1/gi, "")
						.replace(/\bhref\s*=\s*(['"])javascript:[^'"]*\1/gi, 'href="#"')
						.slice(0, BODY_LIMIT * 4);
				}
				return {
					...meta,
					text: text.slice(0, BODY_LIMIT),
					html: safeHtml || undefined,
					truncated: text.length > BODY_LIMIT,
					hasAttachments: (parsed.attachments ?? []).length > 0,
				};
			});
		}

		async function markMails({ folder = "INBOX", uids, seen = true } = {}) {
			const list = (Array.isArray(uids) ? uids : [uids]).map(String);
			if (list.length === 0) return { changed: 0 };
			return withMailbox(folder, async (client) => {
				let changed = 0;
				const flag = "\\Seen";
				for (const uid of list) {
					const ok = seen
						? await client.messageFlagsAdd(uid, [flag], { uid: true })
						: await client.messageFlagsRemove(uid, [flag], { uid: true });
					if (ok) changed++;
				}
				return { changed };
			});
		}

		async function deleteMails({ folder = "INBOX", uids } = {}) {
			const list = (Array.isArray(uids) ? uids : [uids]).map(String);
			if (list.length === 0) return { deleted: 0 };
			return withMailbox(folder, async (client) => {
				let trash = null;
				for await (const f of client.list()) {
					if (f.specialUse === "\\Trash" || /^(trash|deleted|deleted messages|已删除)/i.test(f.path)) {
						trash = f.path;
						break;
					}
				}
				let moved = 0;
				for (const uid of list) {
					const ok = trash
						? await client.messageMove(uid, trash, { uid: true })
						: await client.messageDelete(uid, { uid: true });
					if (ok) moved++;
				}
				return { deleted: moved, trash };
			});
		}

		function stripHtmlTags(html) {
			return String(html ?? "")
				.replace(/<style[\s\S]*?<\/style>/gi, "")
				.replace(/<script[\s\S]*?<\/script>/gi, "")
				.replace(/<br\s*[\/]?>/gi, "\n")
				.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
				.replace(/<[^>]+>/g, " ")
				.replace(/&nbsp;/gi, " ")
				.replace(/&amp;/gi, "&")
				.replace(/&lt;/gi, "<")
				.replace(/&gt;/gi, ">")
				.replace(/&quot;/gi, '"')
				.replace(/&#39;/gi, "'")
				.replace(/[ \t]+/g, " ")
				.replace(/\n\s*\n\s*\n/g, "\n\n")
				.trim();
		}

		const SEND_BODY_LIMIT = 256 * 1024;

		async function sendMail({ to, cc, subject, body, html } = {}) {
			const nd = st.deps.nodemailer;
			if (!nd) throw new Error("依赖未安装：请在设置面板点「安装依赖」");
			const c = st.config?.smtp;
			if (!c?.host || !c?.user) throw new Error("尚未配置 SMTP 账号");

			let textBody = body != null ? String(body) : "";
			let htmlBody = html ? String(html) : undefined;

			if (!textBody && htmlBody) {
				textBody = stripHtmlTags(htmlBody);
			}

			if (textBody.length > SEND_BODY_LIMIT) {
				throw new Error(`正文超出大小上限（${Math.round(SEND_BODY_LIMIT / 1024)}KB）`);
			}
			if (htmlBody && htmlBody.length > SEND_BODY_LIMIT) {
				throw new Error(`HTML 正文超出大小上限（${Math.round(SEND_BODY_LIMIT / 1024)}KB）`);
			}

			if (htmlBody) {
				htmlBody = htmlBody
					.replace(/<script[\s\S]*?<\/script>/gi, "")
					.replace(/\bhref\s*=\s*(['"])javascript:[^'"]*\1/gi, 'href="#"')
					.replace(/\bsrc\s*=\s*(['"])javascript:[^'"]*\1/gi, 'src=""');
			}

			const transport = nd.createTransport({
				host: c.host,
				port: Number(c.port) || 465,
				secure: c.tls !== false,
				auth: { user: c.user, pass: c.pass ?? "" },
			});
			let sender = c.from || c.user;
			if (sender && !sender.includes("@")) {
				sender = `"${sender}" <${c.user}>`;
			}
			const mailOptions = {
				from: sender,
				to: String(to ?? ""),
				cc: cc ? String(cc) : undefined,
				subject: String(subject ?? "(无主题)"),
				text: textBody,
			};
			if (htmlBody) {
				mailOptions.html = htmlBody;
			}
			const info = await transport.sendMail(mailOptions);
			return { messageId: info.messageId, accepted: info.accepted };
		}

		async function refreshModels() {
			try {
				const list = await host.models?.list?.();
				if (Array.isArray(list)) st.availableModels = list;
			} catch {
				st.availableModels = [];
			}
		}

		async function translateWithLlm(text, targetLang, modelId) {
			if (!host.llm?.complete) throw new Error("宿主未支持 host.llm 直调");
			const langName = targetLang === "en" ? "English" : "Chinese";
			const prompt = `Translate the following email content into natural ${langName}. Preserve formatting, line breaks and paragraphs. Output ONLY the translated text without conversational intro or explanations:\n\n${text}`;
			const req = {
				prompt,
				system: "You are a professional email translator. Output only the translation accurately.",
				maxChars: 16000,
				timeoutMs: 60000,
			};
			if (modelId && modelId !== "current") {
				req.model = modelId;
			}
			const res = await host.llm.complete(req);
			if (res.ok && res.text) {
				return { text: res.text.trim(), model: res.model || modelId || "LLM" };
			}
			throw new Error(res.error || "模型补全返回为空");
		}

		async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
			const controller = new AbortController();
			const id = setTimeout(() => controller.abort(), timeoutMs);
			try {
				return await fetch(url, { ...opts, signal: controller.signal });
			} finally {
				clearTimeout(id);
			}
		}

		async function translateChunkGoogle(text, targetLang) {
			const q = encodeURIComponent(text);
			const tl = encodeURIComponent(targetLang);
			const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${q}`;
			const res = await fetchWithTimeout(url);
			if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
			const data = await res.json();
			if (Array.isArray(data?.[0])) {
				return data[0].map((item) => (Array.isArray(item) ? item[0] : "")).join("");
			}
			throw new Error("Google 返回格式异常");
		}

		async function translateChunkMyMemory(text, targetLang) {
			const q = encodeURIComponent(text);
			const tl = encodeURIComponent(targetLang);
			const url = `https://api.mymemory.translated.net/get?q=${q}&langpair=auto|${tl}`;
			const res = await fetchWithTimeout(url);
			if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
			const data = await res.json();
			const trans = data?.responseData?.translatedText;
			if (trans) return trans;
			throw new Error(data?.responseDetails || "MyMemory 返回为空");
		}

		async function translateChunk(text, targetLang) {
			if (!text || !text.trim()) return text;
			try {
				return await translateChunkGoogle(text, targetLang);
			} catch (errGoogle) {
				try {
					return await translateChunkMyMemory(text, targetLang);
				} catch (errMyMem) {
					throw new Error(`翻译请求失败（Google: ${errGoogle?.message}；MyMemory: ${errMyMem?.message}）`);
				}
			}
		}

		async function translateLongText(text, targetLang) {
			if (!text || !text.trim()) return text;
			const paragraphs = text.split("\n");
			const chunks = [];
			let cur = "";
			for (const p of paragraphs) {
				if (cur && cur.length + p.length + 1 > 1200) {
					chunks.push(cur);
					cur = p;
				} else {
					cur = cur ? `${cur}\n${p}` : p;
				}
			}
			if (cur) chunks.push(cur);

			const translatedChunks = [];
			for (const chunk of chunks) {
				if (!chunk.trim()) {
					translatedChunks.push(chunk);
					continue;
				}
				const t = await translateChunk(chunk, targetLang);
				translatedChunks.push(t);
			}
			return translatedChunks.join("\n");
		}

		function protectUrlsForTranslation(rawText) {
			const urls = [];
			let cleaned = cleanMailPlainText(rawText)
				.replace(/\[https?:\/\/[^\s\]]+\.(?:png|jpe?g|gif|svg|webp|ico)(?:\?[^\s\]]*)?\]/gi, "")
				.replace(/\n{3,}/g, "\n\n");

			cleaned = cleaned.replace(/\[https?:\/\/[^\s\]]+\]|https?:\/\/\S+/gi, (match) => {
				const idx = urls.length;
				urls.push(match);
				return `[[URL_${idx}]]`;
			});
			return { cleaned: cleaned.trim(), urls };
		}

		function restoreProtectedUrls(translatedText, urls) {
			if (!urls || !urls.length) return translatedText;
			return String(translatedText ?? "").replace(/\[\[\s*URL_(\d+)\s*\]\]/gi, (_, n) => {
				const idx = Number(n);
				return urls[idx] !== undefined ? urls[idx] : "";
			});
		}

		async function translateMailContent({ subject, text, targetLang, model } = {}) {
			const s = String(subject ?? "").trim();
			const rawB = String(text ?? "").trim();
			if (!s && !rawB) throw new Error("邮件内容为空，无需翻译");

			const { cleaned: b, urls } = protectUrlsForTranslation(rawB);

			let tl = targetLang;
			if (!tl) {
				const sample = `${s} ${b}`.slice(0, 300);
				const hanCount = (sample.match(/[\u4e00-\u9fa5]/g) || []).length;
				const isChinese = hanCount >= 5 && hanCount / sample.length > 0.15;
				tl = isChinese ? "en" : "zh-CN";
			}

			const chosenModel = model !== undefined ? model : st.config?.transModel || "";
			if (chosenModel && chosenModel !== "") {
				try {
					let translatedSubject = "";
					let translatedText = "";
					let modelUsed = chosenModel;

					if (s && b) {
						const combined = `<<SUBJECT>>\n${s}\n<</SUBJECT>>\n<<BODY>>\n${b}\n<</BODY>>`;
						const res = await translateWithLlm(combined, tl, chosenModel);
						modelUsed = res.model;
						const matchSubj = res.text.match(/<<SUBJECT>>\s*([\s\S]*?)\s*<<\/SUBJECT>>/i);
						const matchBody = res.text.match(/<<BODY>>\s*([\s\S]*?)\s*<<\/BODY>>/i);
						if (matchSubj && matchBody) {
							translatedSubject = matchSubj[1].trim();
							translatedText = matchBody[1].trim();
						} else {
							const [ts, tb] = await Promise.all([
								translateWithLlm(s, tl, chosenModel),
								translateWithLlm(b, tl, chosenModel),
							]);
							translatedSubject = ts.text;
							translatedText = tb.text;
						}
					} else if (s) {
						const res = await translateWithLlm(s, tl, chosenModel);
						translatedSubject = res.text;
						modelUsed = res.model;
					} else {
						const res = await translateWithLlm(b, tl, chosenModel);
						translatedText = res.text;
						modelUsed = res.model;
					}

					return {
						translatedSubject,
						translatedText: restoreProtectedUrls(translatedText, urls),
						targetLang: tl,
						engine: "llm",
						model: modelUsed,
					};
				} catch (errLlm) {
					host.log(`大模型翻译失败 (${errLlm?.message})，自动回退到快速公共引擎`);
				}
			}

			const [translatedSubject, translatedText] = await Promise.all([
				s ? translateChunk(s, tl) : Promise.resolve(""),
				b ? translateLongText(b, tl) : Promise.resolve(""),
			]);

			return {
				translatedSubject,
				translatedText: restoreProtectedUrls(translatedText, urls),
				targetLang: tl,
				engine: "fast",
				model: chosenModel ? `回退自 ${chosenModel}` : undefined,
			};
		}

		async function countUnseen() {
			return withMailbox("INBOX", async (client) => ({
				uids: (await client.search({ seen: false }, { uid: true })) ?? [],
			}));
		}

		async function pollOnce() {
			if (!st.config?.imap?.host || !st.depsOk || st.pollBusy) return;
			st.pollBusy = true;
			try {
				const { uids } = await countUnseen();
				st.lastCheckAt = Date.now();
				const fresh = uids.filter((u) => !st.lastUnseenUids.has(u));
				st.unseenTotal = uids.length;
				if (st.firstPollDone && fresh.length > 0) {
					let subjects = [];
					try {
						const summaries = await listMails({ folder: "INBOX", limit: 10 });
						subjects = summaries
							.filter((m) => fresh.includes(m.uid))
							.slice(0, 3)
							.map((m) => `${m.fromName || m.from}: ${m.subject}`);
					} catch {}
					if (st.config.notifyEnabled !== false) {
						host.notify("info", `📬 ${fresh.length} 封新邮件${subjects.length ? ` — ${subjects.join(" · ")}` : ""}`);
					}
					host.broadcast({
						kind: "new-mail",
						count: fresh.length,
						unseen: uids.length,
						subjects,
					});
				}
				st.firstPollDone = true;
				st.lastUnseenUids = new Set(uids);
				st.status = "已连接";
			} catch (err) {
				st.status = `连接失败：${err?.message ?? err}`;
				dropClient();
			} finally {
				st.pollBusy = false;
				broadcastState();
			}
		}

		function restartPoller() {
			if (st.dead) return;
			if (st.pollTimer) clearInterval(st.pollTimer);
			st.pollTimer = null;
			st.lastUnseenUids.clear();
			st.firstPollDone = false;
			const sec = Math.max(15, Math.floor(Number(st.config?.pollSec) || 60));
			if (st.config?.imap?.host && st.depsOk) {
				st.pollTimer = setInterval(() => void serialized(pollOnce).catch(() => {}), sec * 1000);
				void serialized(pollOnce).catch(() => {});
				if (st.bgTask) st.bgTask.update({ label: "📬 邮件轮询", status: `每 ${sec}s` });
				else {
					st.bgTask = host.registerBackgroundTask?.({
						id: "mail-poll",
						label: "📬 邮件轮询",
						status: `每 ${sec}s`,
						stop: () => {
							if (st.pollTimer) clearInterval(st.pollTimer);
							st.pollTimer = null;
							host.log("polling stopped from background panel");
						},
					});
				}
			} else {
				st.bgTask?.unregister?.();
				st.bgTask = null;
				broadcastState();
			}
		}

		const FOLDER_PARAM = {
			type: "string",
			description: "Mailbox folder path, default INBOX",
		};

		function describeMail(m) {
			return `#${m.uid}${m.seen ? "" : " [未读]"} ${m.date.slice(0, 16).replace("T", " ")} ${m.fromName || m.from} — ${m.subject}`;
		}

		function aiTools() {
			return [
				{
					name: "mail",
					label: "邮箱",
					description:
						"Read and manage the configured mailbox over IMAP, and send mail (plain text, optionally with an HTML alternative) over SMTP. " +
						"Each action's arguments are documented on the parameters below.",
					promptSnippet: "list/read/search/send/manage mailbox mail",
					promptGuidelines: [
						"Confirm recipient, subject, and body with the user once before action=send",
						"Use action=folders first if the folder path is unknown",
					],
					parameters: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: ["list", "read", "search", "send", "manage", "folders"],
								description: "The mail action to perform.",
							},
							folder: FOLDER_PARAM,
							limit: {
								type: "number",
								description: "list/search: number of results, default 30 (search 20), max 200",
							},
							unseen_only: { type: "boolean", description: "list: only unread mail, default false" },
							uid: { type: "number", description: "read: #id returned by action=list" },
							query: { type: "string", description: "search: keyword" },
							to: { type: "string", description: "send: recipient email address" },
							cc: { type: "string", description: "send: CC (optional)" },
							subject: { type: "string", description: "send: subject" },
							body: { type: "string", description: "send: body (plain text)" },
							html: {
								type: "string",
								description: "send: HTML body (optional; sent alongside body as multipart/alternative)",
							},
							manage_action: {
								type: "string",
								enum: ["seen", "unseen", "delete"],
								description: "manage: operation type",
							},
							uids: {
								type: "array",
								items: { type: "number" },
								description: "manage: list of mail uids",
							},
						},
						required: ["action"],
					},
					execute: async (_id, args) => {
						const action = String(args.action ?? "")
							.trim()
							.toLowerCase();
						switch (action) {
							case "list": {
								const mails = await listMails(args);
								if (mails.length === 0) return "邮箱为空（或没有未读）。";
								return mails.map(describeMail).join("\n");
							}
							case "read": {
								if (typeof args.uid !== "number") return "读信缺少 uid 参数。";
								const m = await readMail(args);
								return [
									`主题: ${m.subject}`,
									`发件人: ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}`,
									`日期: ${m.date}`,
									m.hasAttachments ? "(含附件)" : "",
									"",
									m.text + (m.truncated ? "\n…(截断)" : ""),
								]
									.filter(Boolean)
									.join("\n");
							}
							case "search": {
								if (!args.query) return "搜索缺少 query 参数。";
								const mails = await searchMails(args);
								if (mails.length === 0) return `没有匹配 “${args.query}” 的邮件。`;
								return mails.map(describeMail).join("\n");
							}
							case "send": {
								if (!args.to || (!args.body && !args.html)) return "发信需要 to 与 (body 或 html) 参数。";
								const r = await sendMail(args);
								return `已发送至 ${(r.accepted ?? []).join(", ")}`;
							}
							case "manage": {
								if (!Array.isArray(args.uids) || args.uids.length === 0) return "管理邮件需要 uids 参数。";
								if (args.manage_action === "delete") {
									const r = await deleteMails(args);
									return `已删除 ${r.deleted} 封${r.trash ? `（移入 ${r.trash}）` : ""}`;
								}
								const r = await markMails({ ...args, seen: args.manage_action === "seen" });
								return `已更新 ${r.changed} 封邮件状态`;
							}
							case "folders": {
								return withMailbox("INBOX", async (client) => {
									const out = [];
									for await (const f of client.list()) {
										out.push(`${f.path}${f.specialUse ? ` (${f.specialUse})` : ""}`);
									}
									return out.join("\n");
								});
							}
							default:
								return `未知 action：${args.action ?? ""}。支持的 action：list, read, search, send, manage, folders。`;
						}
					},
				},
			];
		}

		async function refreshAiTools() {
			st.toolUnregister?.();
			st.toolUnregister = null;
			if (st.depsOk) {
				const offs = aiTools().map((t) => host.registerAgentTool(t));
				st.toolUnregister = () => offs.forEach((off) => off());
				host.log("AI 邮箱工具已开启");
			}
		}

		const offMsg = host.onMessage((payload, from) => {
			const msg = payload ?? {};
			switch (msg.action) {
				case "get_state":
					if (from) host.sendTo(from, { kind: "state", state: publicState() });
					else broadcastState();
					break;
				case "save_config":
					void (async () => {
						try {
							await applyConfig({
								...structuredClone(DEFAULT_CONFIG),
								...msg.config,
								imap: { ...DEFAULT_CONFIG.imap, ...msg.config?.imap },
								smtp: { ...DEFAULT_CONFIG.smtp, ...msg.config?.smtp },
							});
							host.sendTo(from, { kind: "result", ok: true, action: "save_config" });
							host.notify("info", "📬 邮箱配置已保存并生效");
						} catch (err) {
							host.sendTo(from, {
								kind: "result",
								ok: false,
								action: "save_config",
								error: err?.message ?? String(err),
							});
						}
					})();
					break;
				case "install_deps":
					installDeps();
					break;
				case "list":
					void serialized(() => listMails(msg))
						.then((mails) => host.broadcast({ kind: "mails", mails }))
						.catch((err) => {
							st.status = err?.message ?? String(err);
							broadcastState();
						});
					break;
				case "read":
					void serialized(() => readMail(msg))
						.then((mail) => host.broadcast({ kind: "mail", mail }))
						.catch((err) => host.notify("error", `📬 读取失败：${err?.message ?? err}`));
					break;
				case "search":
					void serialized(() => searchMails(msg))
						.then((mails) => host.broadcast({ kind: "mails", mails }))
						.catch((err) => host.notify("error", `📬 搜索失败：${err?.message ?? err}`));
					break;
				case "mark":
					void serialized(() => markMails(msg))
						.then((r) => host.broadcast({ kind: "result", ok: true, action: "mark", ...r }))
						.catch((err) => host.notify("error", `📬 标记失败：${err?.message ?? err}`));
					break;
				case "delete":
					void serialized(() => deleteMails(msg))
						.then((r) => host.broadcast({ kind: "result", ok: true, action: "delete", ...r }))
						.catch((err) => host.notify("error", `📬 删除失败：${err?.message ?? err}`));
					break;
				case "send":
					void sendMail(msg)
						.then(() => {
							host.notify("info", `📬 已发送给 ${msg.to}`);
							host.broadcast({ kind: "result", ok: true, action: "send" });
						})
						.catch((err) => host.notify("error", `📬 发送失败：${err?.message ?? err}`));
					break;
				case "translate":
					void (async () => {
						try {
							const res = await translateMailContent(msg);
							host.broadcast({
								kind: "translated",
								uid: msg.uid,
								ok: true,
								...res,
							});
						} catch (err) {
							host.broadcast({
								kind: "translated",
								uid: msg.uid,
								ok: false,
								error: err?.message ?? String(err),
							});
							host.notify("error", `📬 翻译失败：${err?.message ?? err}`);
						}
					})();
					break;
				default:
					host.log("unknown action:", msg.action);
			}
		});

		void (async () => {
			try {
				st.config = await loadConfigSecure();
				if (st.dead) return;
				await loadDeps();
				if (st.dead) return;
				await refreshModels();
				if (st.dead) return;
				if (!st.depsOk) installDeps(true);
				await refreshAiTools();
				if (st.dead) return;
				restartPoller();
				broadcastState();
				host.log("activated", st.depsOk ? "(依赖就绪)" : "(装依赖中)");
			} catch (err) {
				host.log("activation failed:", err);
			}
		})();

		const offAttach = host.onAttach?.((clientId) => {
			host.sendTo(clientId, { kind: "state", state: publicState() });
		});

		return () => {
			st.dead = true;
			offMsg();
			try {
				offAttach?.();
			} catch {}
			st.toolUnregister?.();
			try {
				st.bgTask?.unregister?.();
			} catch {}
			if (st.pollTimer) clearInterval(st.pollTimer);
			try {
				st.installChild?.kill();
			} catch {}
			dropClient();
			host.log("deactivated");
		};
	},
};
