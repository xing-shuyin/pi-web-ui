import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { createSession, postCompletion, buildRepeatPrompt } from "./lib/session.mjs";
import { obtainPowHeader, POW_TARGET_COMPLETION } from "./lib/pow.mjs";
import { synthesizeToWavBuffer } from "./lib/tts.mjs";

const DOUBAO_SPEAKERS = {
	yangguang: "zh_male_qingyiyuxuan_mars_bigtts",
	阳光青年: "zh_male_qingyiyuxuan_mars_bigtts",
	阳光阿辰: "zh_male_qingyiyuxuan_mars_bigtts",

	junyu: "zh_male_nuanxinshizhe_mars_bigtts",
	磁性俊宇: "zh_male_nuanxinshizhe_mars_bigtts",

	nanda: "zh_male_junlangxize_mars_bigtts",
	清爽男大: "zh_male_junlangxize_mars_bigtts",

	taozi: "zh_female_wenroutaozi_uranus_bigtts",
	温柔桃子: "zh_female_wenroutaozi_uranus_bigtts",

	tianmei: "zh_female_xiaohe_conversation_wvae_bigtts",
	阳光甜妹: "zh_female_xiaohe_conversation_wvae_bigtts",

	xiaotang: "zh_female_wenroutaozi_mars_bigtts",
	知性小棠: "zh_female_wenroutaozi_mars_bigtts",

	shuangkuai: "zh_female_beijingdaniu_mars_bigtts",
	北京大妞: "zh_female_beijingdaniu_mars_bigtts",

	bazong: "ICL_e0b9b93ee322",
	冷酷霸总: "ICL_e0b9b93ee322",

	bingjiao: "ICL_72afa6c5dc07",
	病娇少爷: "ICL_72afa6c5dc07",
};

const DEEPSEEK_VOICES = {
	echo: "echo",
	白浪: "echo",
	tide: "tide",
	暗潮: "tide",
	mira: "mira",
	贝壳: "mira",
	stella: "stella",
	海星: "stella",
};

const DOUBAO_WS_URL = "wss://ws-samantha.doubao.com/samantha/audio/tts";

function createZip(files) {
	const localHeaders = [];
	const centralHeaders = [];
	let offset = 0;

	for (const file of files) {
		const nameBuf = Buffer.from(file.name, "utf-8");
		const dataBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf-8");

		let crc = 0 ^ -1;
		for (let i = 0; i < dataBuf.length; i++) {
			crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ dataBuf[i]) & 0xff];
		}
		crc = (crc ^ -1) >>> 0;

		const size = dataBuf.length;

		const localHdr = Buffer.alloc(30);
		localHdr.writeUInt32LE(0x04034b50, 0);
		localHdr.writeUInt16LE(20, 4);
		localHdr.writeUInt16LE(0x0800, 6);
		localHdr.writeUInt16LE(0, 8);
		localHdr.writeUInt16LE(0, 10);
		localHdr.writeUInt16LE(0, 12);
		localHdr.writeUInt32LE(crc, 14);
		localHdr.writeUInt32LE(size, 18);
		localHdr.writeUInt32LE(size, 22);
		localHdr.writeUInt16LE(nameBuf.length, 26);
		localHdr.writeUInt16LE(0, 28);

		localHeaders.push(localHdr, nameBuf, dataBuf);

		const centralHdr = Buffer.alloc(46);
		centralHdr.writeUInt32LE(0x02014b50, 0);
		centralHdr.writeUInt16LE(20, 4);
		centralHdr.writeUInt16LE(20, 6);
		centralHdr.writeUInt16LE(0x0800, 8);
		centralHdr.writeUInt16LE(0, 10);
		centralHdr.writeUInt16LE(0, 12);
		centralHdr.writeUInt16LE(0, 14);
		centralHdr.writeUInt32LE(crc, 16);
		centralHdr.writeUInt32LE(size, 20);
		centralHdr.writeUInt32LE(size, 24);
		centralHdr.writeUInt16LE(nameBuf.length, 28);
		centralHdr.writeUInt16LE(0, 30);
		centralHdr.writeUInt16LE(0, 32);
		centralHdr.writeUInt16LE(0, 34);
		centralHdr.writeUInt16LE(0, 36);
		centralHdr.writeUInt32LE(0, 38);
		centralHdr.writeUInt32LE(offset, 42);

		centralHeaders.push(centralHdr, nameBuf);
		offset += localHdr.length + nameBuf.length + dataBuf.length;
	}

	const centralDirOffset = offset;
	const centralDirBuf = Buffer.concat(centralHeaders);
	const centralDirSize = centralDirBuf.length;

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralDirSize, 12);
	eocd.writeUInt32LE(centralDirOffset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...localHeaders, centralDirBuf, eocd]);
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	CRC_TABLE[n] = c >>> 0;
}

export default {
	activate(host) {
		if (!host.tts) throw new Error("当前宿主缺少统一 TTS 中心，请更新 pi-web-ui");
		const cookieFile = path.join(host.dir, "doubao_cookie.txt");
		const legacyCookieFile = path.join(host.dir, "cookie.txt");
		const dsTokenFile = path.join(host.dir, "deepseek_token.txt");
		const dsSessionFile = path.join(host.dir, "deepseek_bridge_session.json");
		const extDir = path.join(host.dir, "extension");

		async function readDoubaoCookie() {
			try {
				if (existsSync(cookieFile)) return (await fs.readFile(cookieFile, "utf-8")).trim();
				if (existsSync(legacyCookieFile)) return (await fs.readFile(legacyCookieFile, "utf-8")).trim();
			} catch {}
			return "";
		}

		async function readDeepSeekToken() {
			const settings = host.getSettings?.() ?? {};
			if (settings.deepseekToken && settings.deepseekToken.trim()) {
				return settings.deepseekToken.trim();
			}
			try {
				if (existsSync(dsTokenFile)) return (await fs.readFile(dsTokenFile, "utf-8")).trim();
			} catch {}
			return "";
		}

		async function getStableDeviceInfo() {
			const devFile = path.join(host.dir, "device.json");
			try {
				if (existsSync(devFile)) {
					const d = JSON.parse(await fs.readFile(devFile, "utf-8"));
					if (d.deviceId && d.webId) return d;
				}
			} catch {}
			const stable = {
				deviceId: "7695341014752790016",
				webId: "7695341019042711076",
			};
			try {
				await fs.writeFile(devFile, JSON.stringify(stable), "utf-8");
			} catch {}
			return stable;
		}

		async function synthesizeDoubao(text, speakerKey = "yangguang", speed = 0, format = "aac", signal) {
			const requestSignal = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
			requestSignal.throwIfAborted();
			const settings = host.getSettings?.() ?? {};
			const apiKey = (settings.doubaoApiKey || "").trim();

			if (apiKey) {
				const officialVoiceMap = {
					yangguang: "BV007_streaming",
					阳光青年: "BV007_streaming",
					阳光阿辰: "BV007_streaming",
					taozi: "BV001_streaming",
					温柔桃子: "BV001_streaming",
					tianmei: "BV001_streaming",
					junyu: "BV007_streaming",
				};
				const voiceType = officialVoiceMap[speakerKey] || "BV007_streaming";

				const res = await fetch("https://openspeech.bytedance.com/api/v1/tts", {
					method: "POST",
					signal: requestSignal,
					headers: {
						"x-api-key": apiKey,
						"X-Api-Resource-Id": "seed-tts-2.0",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						audio: {
							voice_type: voiceType,
							encoding: format === "mp3" ? "mp3" : "aac",
							speed_ratio: Math.max(0.5, Math.min(2.0, 1.0 + speed)),
						},
						request: { text },
					}),
				});

				const json = await res.json();
				if (json.data) return Buffer.from(json.data, "base64");
				throw new Error(`火山引擎接口错误: ${json.message || JSON.stringify(json)}`);
			}

			const cookie = await readDoubaoCookie();
			if (!cookie) {
				throw new Error("尚未获取豆包登录凭据，请在浏览器中安装配套扩展并点击一键同步。");
			}

			const speakerId =
				DOUBAO_SPEAKERS[speakerKey] ||
				(typeof speakerKey === "string" && (speakerKey.startsWith("zh_") || speakerKey.startsWith("ICL_"))
					? speakerKey
					: "zh_male_qingyiyuxuan_mars_bigtts");

			const { deviceId, webId } = await getStableDeviceInfo();

			const params = new URLSearchParams({
				speaker: speakerId,
				format: format,
				speech_rate: String(Math.round(speed * 100)),
				pitch: "0",
				version_code: "20800",
				language: "zh",
				device_platform: "web",
				aid: "497858",
				real_aid: "497858",
				pkg_type: "release_version",
				device_id: deviceId,
				pc_version: "2.46.3",
				web_id: webId,
				tea_uuid: webId,
				samantha_web: "1",
				"use-olympus-account": "1",
				web_tab_id: crypto.randomUUID(),
			});

			const wsUrl = `${DOUBAO_WS_URL}?${params.toString()}`;
			const chunks = [];

			return new Promise((resolve, reject) => {
				requestSignal.throwIfAborted();
				const WebSocketClient = globalThis.WebSocket;
				if (!WebSocketClient) throw new Error("当前 Node 环境不支持原生 WebSocket");
				const ws = new WebSocketClient(wsUrl, {
					headers: { Origin: "https://www.doubao.com", "User-Agent": "Mozilla/5.0", Cookie: cookie },
				});
				ws.binaryType = "arraybuffer";
				let settled = false;
				const finish = (error) => {
					if (settled) return;
					settled = true;
					requestSignal.removeEventListener("abort", onAbort);
					try {
						ws.close();
					} catch {}
					if (error) reject(error);
					else if (!chunks.length) reject(new Error("未能接收到音频数据"));
					else resolve(Buffer.concat(chunks));
				};
				const onAbort = () => finish(requestSignal.reason);
				requestSignal.addEventListener("abort", onAbort, { once: true });
				ws.onopen = () => {
					if (!settled) {
						ws.send(JSON.stringify({ event: "text", text }));
						ws.send(JSON.stringify({ event: "finish" }));
					}
				};
				ws.onmessage = async (event) => {
					if (settled) return;
					if (typeof event.data === "string") {
						let msg;
						try {
							msg = JSON.parse(event.data);
						} catch {
							return;
						}
						if (msg.code === 710022002 || msg.message === "block")
							finish(new Error("触发豆包网页频次拦截，请稍后重试或配置官方 API Key"));
						else if (msg.event === "error" || (msg.code && msg.code !== 0))
							finish(new Error(msg.message || `豆包返回错误 (${msg.code})`));
					} else {
						try {
							const buffer =
								event.data instanceof ArrayBuffer
									? Buffer.from(event.data)
									: Buffer.from(await event.data.arrayBuffer());
							if (!settled) chunks.push(buffer);
						} catch (error) {
							finish(error);
						}
					}
				};
				ws.onclose = () => finish();
				ws.onerror = () => finish(new Error("豆包语音 WebSocket 连接失败"));
			});
		}

		let dsLastCallTime = 0;

		function hashToken(token) {
			return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
		}

		async function getOrCreateDeepSeekSession(token, signal) {
			signal?.throwIfAborted();
			try {
				if (existsSync(dsSessionFile)) {
					const info = JSON.parse(await fs.readFile(dsSessionFile, "utf-8"));
					if (info && info.sessionId && info.tokenHash === hashToken(token)) {
						return { sessionId: info.sessionId, lastMessageId: info.lastMessageId || null, isNew: false };
					}
				}
			} catch {}

			const session = await createSession({ token, signal });
			const info = {
				sessionId: session.id,
				tokenHash: hashToken(token),
				lastMessageId: null,
				createdAt: Date.now(),
			};
			try {
				await fs.writeFile(dsSessionFile, JSON.stringify(info, null, 2), "utf-8");
			} catch {}
			host.log(`已建立 DeepSeek 专属语音会话: ${session.id}（已持久化复用）`);
			return { sessionId: session.id, lastMessageId: null, isNew: true };
		}

		async function updateDeepSeekSessionMessage(sessionId, messageId, token) {
			try {
				const info = {
					sessionId,
					tokenHash: hashToken(token),
					lastMessageId: messageId,
					updatedAt: Date.now(),
				};
				await fs.writeFile(dsSessionFile, JSON.stringify(info, null, 2), "utf-8");
			} catch {}
		}

		async function clearDeepSeekSession() {
			try {
				if (existsSync(dsSessionFile)) {
					await fs.unlink(dsSessionFile);
				}
			} catch {}
		}

		async function synthesizeDeepSeek(text, voiceKey = "echo", signal) {
			const run = async () => {
				const token = await readDeepSeekToken();
				if (!token) {
					throw new Error(
						"尚未配置 DeepSeek 登录凭据，请在插件设置中填入 userToken 或通过配套扩展在 chat.deepseek.com 页面同步。",
					);
				}

				const now = Date.now();
				const elapsed = now - dsLastCallTime;
				if (elapsed < 400) {
					await delay(400 - elapsed, undefined, { signal });
				}
				dsLastCallTime = Date.now();

				const voiceId = DEEPSEEK_VOICES[voiceKey] || "echo";

				let attempts = 0;
				while (attempts < 2) {
					attempts++;
					signal?.throwIfAborted();
					const { sessionId, lastMessageId } = await getOrCreateDeepSeekSession(token, signal);

					try {
						const pow = await obtainPowHeader({
							targetPath: POW_TARGET_COMPLETION,
							token,
							signal,
						});

						const prompt = buildRepeatPrompt(text);

						const res = await postCompletion({
							sessionId,
							parentMessageId: lastMessageId,
							prompt,
							powHeader: pow.header,
							token,
							thinkingEnabled: false,
							searchEnabled: false,
							signal,
						});

						if (!res.ok) {
							if (res.status === 400 || res.status === 404 || res.status === 500) {
								host.log(`DeepSeek 专属会话失效 (HTTP ${res.status})，正在自动自愈重建...`);
								await clearDeepSeekSession();
								if (attempts < 2) continue;
							}
							throw new Error(`DeepSeek completion 请求失败 (HTTP ${res.status})`);
						}

						let messageId = null;
						const reader = res.body.getReader();
						const decoder = new TextDecoder();
						while (true) {
							const { value, done } = await reader.read();
							if (done) break;
							const chunk = decoder.decode(value);
							const m = chunk.match(/"response_message_id":(\d+)/);
							if (m) messageId = Number(m[1]);
						}

						if (!messageId) {
							messageId = 2;
						}

						await updateDeepSeekSessionMessage(sessionId, messageId, token);

						const { wav } = await synthesizeToWavBuffer({
							sessionId,
							messageId,
							token,
							voice: voiceId,
							signal,
						});

						return wav;
					} catch (err) {
						if (attempts < 2 && (err.message.includes("400") || err.message.includes("session"))) {
							await clearDeepSeekSession();
							continue;
						}
						throw err;
					}
				}
			};

			return run();
		}

		function isTrustedOrigin(req) {
			const origin = String(req?.headers?.origin ?? "");
			if (!origin || origin === "null") return true;
			if (origin.startsWith("chrome-extension://")) return true;
			try {
				const u = new URL(origin);
				if (u.protocol !== "http:" && u.protocol !== "https:") return false;
				return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
			} catch {
				return false;
			}
		}
		function corsJson(req, extra = {}) {
			const headers = { "Content-Type": "application/json", ...extra };
			if (isTrustedOrigin(req)) {
				const origin = String(req?.headers?.origin ?? "");
				headers["Access-Control-Allow-Origin"] = origin || "*";
				headers["Access-Control-Allow-Headers"] = "Content-Type";
				headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
			}
			return headers;
		}

		host.route("POST", "/sync-credentials", async (req, res) => {
			try {
				let body = req.body;
				if (typeof body === "string") {
					try {
						body = JSON.parse(body);
					} catch {}
				}
				const { doubaoCookie, deepseekToken, cookie } = body || {};

				let updated = [];
				if (doubaoCookie || cookie) {
					await fs.writeFile(cookieFile, String(doubaoCookie || cookie).trim(), "utf-8");
					updated.push("doubao");
				}
				if (deepseekToken) {
					await fs.writeFile(dsTokenFile, String(deepseekToken).trim(), "utf-8");
					updated.push("deepseek");
				}

				host.log(`已接收并保存凭据: ${updated.join(", ")}`);
				host.broadcast({
					type: "credentials-updated",
					hasDoubao: Boolean(doubaoCookie || cookie),
					hasDeepseek: Boolean(deepseekToken),
				});

				res.writeHead(200, corsJson(req));
				res.end(JSON.stringify({ ok: true, updated }));
			} catch (err) {
				res.writeHead(500, corsJson(req));
				res.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		host.route("OPTIONS", "/sync-credentials", (req, res) => {
			const headers = { "Access-Control-Allow-Methods": "POST, OPTIONS" };
			if (isTrustedOrigin(req)) {
				headers["Access-Control-Allow-Origin"] = String(req?.headers?.origin ?? "") || "*";
				headers["Access-Control-Allow-Headers"] = "Content-Type";
			}
			res.writeHead(204, headers);
			res.end();
		});

		host.route("POST", "/sync-cookie", (req, res) => {
			return host.handleHttp("tts", "POST", "/sync-credentials", req, res);
		});

		const unregisterEngines = [
			host.tts.registerEngine({
				id: "doubao-tts",
				label: "豆包语音",
				labelEn: "Doubao Voice",
				getVoices: () =>
					Object.entries(DOUBAO_SPEAKERS)
						.filter(([key]) => /^[a-z]/.test(key))
						.map(([id, value]) => ({
							id,
							label:
								Object.entries(DOUBAO_SPEAKERS).find(
									([key, voice]) => /[\u4e00-\u9fff]/.test(key) && voice === value,
								)?.[0] || id,
							lang: "zh-CN",
						})),
				synthesize: async ({ text, voice, rate, signal }) => ({
					buffer: await synthesizeDoubao(text, voice || "yangguang", (rate || 1) - 1, "aac", signal),
					format: "aac",
				}),
			}),
			host.tts.registerEngine({
				id: "deepseek-tts",
				label: "DeepSeek 语音",
				labelEn: "DeepSeek Voice",
				supportsRate: false,
				getVoices: () =>
					Object.entries(DEEPSEEK_VOICES)
						.filter(([key]) => /[\u4e00-\u9fff]/.test(key))
						.map(([label, id]) => ({ id, label, lang: "zh-CN" })),
				synthesize: async ({ text, voice, signal }) => ({
					buffer: await synthesizeDeepSeek(text, voice || "echo", signal),
					format: "wav",
				}),
			}),
		];
		const engineId = (id) => (id === "doubao" || id === "deepseek" ? `${id}-tts` : id);

		host.route("POST", "/speak", async (req, res) => {
			try {
				let body = req.body;
				if (typeof body === "string") {
					try {
						body = JSON.parse(body);
					} catch {}
				}
				const text = String(body?.text || "").trim();
				const engine = String(body?.engine || "doubao");
				const speaker = String(body?.speaker || "");
				const speed = typeof body?.speed === "number" ? body.speed : 0;

				if (!text) {
					res.writeHead(400, { "Content-Type": "application/json" });
					return res.end(JSON.stringify({ ok: false, error: "Text is empty" }));
				}

				const { buffer: buf, format } = await host.tts.synthesize({
					text,
					engine: engineId(engine),
					voice: speaker,
					rate: 1 + speed,
				});

				res.writeHead(200, corsJson(req));
				res.end(JSON.stringify({ ok: true, audioBase64: buf.toString("base64"), format }));
			} catch (err) {
				res.writeHead(500, corsJson(req));
				res.end(JSON.stringify({ ok: false, error: err.message }));
			}
		});

		host.route("OPTIONS", "/speak", (req, res) => {
			const headers = { "Access-Control-Allow-Methods": "POST, OPTIONS" };
			if (isTrustedOrigin(req)) {
				headers["Access-Control-Allow-Origin"] = String(req?.headers?.origin ?? "") || "*";
				headers["Access-Control-Allow-Headers"] = "Content-Type";
			}
			res.writeHead(204, headers);
			res.end();
		});

		host.route("POST", "/reset-deepseek-session", async (req, res) => {
			await clearDeepSeekSession();
			host.log("已手动重置 DeepSeek 专属语音会话");
			res.writeHead(200, corsJson(req));
			res.end(JSON.stringify({ ok: true }));
		});

		host.route("OPTIONS", "/reset-deepseek-session", (req, res) => {
			const headers = { "Access-Control-Allow-Methods": "POST, OPTIONS" };
			if (isTrustedOrigin(req)) {
				headers["Access-Control-Allow-Origin"] = String(req?.headers?.origin ?? "") || "*";
				headers["Access-Control-Allow-Headers"] = "Content-Type";
			}
			res.writeHead(204, headers);
			res.end();
		});

		host.route("POST", "/open-folder", (req, res) => {
			if (process.platform === "win32") exec(`explorer.exe "${extDir}"`);
			else if (process.platform === "darwin") exec(`open "${extDir}"`);
			else exec(`xdg-open "${extDir}"`);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});

		host.route("GET", "/download-extension", async (req, res) => {
			try {
				const extFiles = [
					{ name: "manifest.json", path: path.join(extDir, "manifest.json") },
					{ name: "background.js", path: path.join(extDir, "background.js") },
					{ name: "popup.html", path: path.join(extDir, "popup.html") },
					{ name: "popup.js", path: path.join(extDir, "popup.js") },
				];
				const fileEntries = [];
				for (const item of extFiles) {
					if (existsSync(item.path)) {
						const data = await fs.readFile(item.path);
						fileEntries.push({ name: item.name, data });
					}
				}
				const zipBuffer = createZip(fileEntries);
				res.writeHead(200, {
					"Content-Type": "application/zip",
					"Content-Disposition": 'attachment; filename="tts-extension.zip"',
					"Content-Length": zipBuffer.length,
				});
				res.end(zipBuffer);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end(`打包扩展失败: ${err.message}`);
			}
		});

		host.registerAgentTool?.({
			name: "tts",
			label: "TTS 语音合成",
			promptSnippet: "synthesize speech audio file from text",
			description: "List TTS engines and voices or synthesize an audio file through the shared TTS center.",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["synthesize", "list"],
						description: "List engines/voices or synthesize audio (default).",
					},
					text: { type: "string", description: "Text to convert to speech audio" },
					engine: {
						type: "string",
						description:
							"Registered engine ID from action=list; defaults to plugin settings. Legacy doubao/deepseek IDs are accepted.",
					},
					rate: { type: "number", description: "Speech speed, 0.5 to 2 (default 1)." },
					speaker: {
						type: "string",
						description: "Voice ID from action=list with an engine, or omit to use the engine default.",
					},
					outFile: { type: "string", description: "Output path, e.g. voice.aac or voice.wav" },
				},
				required: [],
			},
			execute: async (...callArgs) => {
				const args =
					callArgs.length >= 2 &&
					typeof callArgs[0] === "string" &&
					typeof callArgs[1] === "object" &&
					callArgs[1] !== null
						? callArgs[1]
						: typeof callArgs[0] === "object" && callArgs[0] !== null
							? callArgs[0]
							: {};

				if (args.action === "list") {
					return args.engine
						? { engine: engineId(args.engine), voices: await host.tts.listVoices(engineId(args.engine)) }
						: { engines: host.tts.listEngines() };
				}
				const text = String(args.text || "").trim();
				if (!text) {
					throw new Error("Text parameter cannot be empty.");
				}

				const settings = host.getSettings?.() ?? {};
				const defaultEngine = String(settings.defaultEngine || "doubao");
				const engine = engineId(args.engine || defaultEngine);
				const speaker = String(args.speaker || "");
				const { buffer: buf, format: defaultExt } = await host.tts.synthesize({
					text,
					engine,
					voice: speaker,
					rate: args.rate,
					signal: callArgs[2],
				});

				const rawOut = args.outFile ? String(args.outFile).trim() : `tts_${Date.now()}.${defaultExt}`;
				const cwdBase = path.resolve(host.cwd);
				const resolvedOut = path.isAbsolute(rawOut) ? path.resolve(rawOut) : path.resolve(cwdBase, rawOut);
				const cwdPrefix = cwdBase.endsWith(path.sep) ? cwdBase : cwdBase + path.sep;
				if (resolvedOut !== cwdBase && !resolvedOut.startsWith(cwdPrefix)) {
					throw new Error(`outFile 越出工作区: ${JSON.stringify(rawOut)}`);
				}
				const outPath = resolvedOut;
				await fs.writeFile(outPath, buf);

				return { success: true, path: outPath, bytes: buf.length, engine, speaker };
			},
		});

		const offMessage = host.onMessage(async (msg) => {
			if (!msg) return;

			if (msg.action === "get-voices") {
				const engine = engineId(msg.engine || "builtin");
				try {
					host.broadcast({ type: "voices-response", engine, voices: await host.tts.listVoices(engine) });
				} catch (error) {
					host.broadcast({ type: "voices-response", engine, voices: [], error: error.message });
				}
			} else if (msg.action === "get-status") {
				const doubaoCookie = await readDoubaoCookie();
				const dsToken = await readDeepSeekToken();
				const settings = host.getSettings?.() ?? {};
				host.broadcast({
					type: "status-response",
					engines: host.tts.listEngines(),
					hasDoubao: Boolean(doubaoCookie && doubaoCookie.includes("sessionid")),
					hasDoubaoApiKey: Boolean(settings.doubaoApiKey?.trim()),
					hasDeepseek: Boolean(dsToken && dsToken.length > 20),
				});
			} else if (msg.action === "test-speak") {
				try {
					const text = msg.text || "你好，这是语音合成试听。";
					const engine = msg.engine || "doubao";
					const speaker = msg.speaker || "";

					const { buffer: buf, format } = await host.tts.synthesize({ text, engine: engineId(engine), voice: speaker });

					host.broadcast({
						type: "speak-result",
						success: true,
						audioBase64: buf.toString("base64"),
						format,
						text,
					});
				} catch (err) {
					host.broadcast({
						type: "speak-result",
						success: false,
						error: err.message,
					});
				}
			} else if (msg.action === "clear-credentials") {
				try {
					if (existsSync(cookieFile)) await fs.unlink(cookieFile);
					if (existsSync(dsTokenFile)) await fs.unlink(dsTokenFile);
					await clearDeepSeekSession();
					host.broadcast({ type: "status-response", hasDoubao: false, hasDeepseek: false });
				} catch {}
			} else if (msg.action === "reset-deepseek-session") {
				try {
					await clearDeepSeekSession();
					host.broadcast({ type: "deepseek-session-reset", ok: true });
				} catch {}
			}
		});

		host.log("多源 TTS 语音合成插件已激活");

		return () => {
			offMessage?.();
			unregisterEngines.forEach((off) => off());
		};
	},
};
