import fs from "node:fs/promises";
import { existsSync, mkdirSync, createReadStream, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

function findZipEocd(buf) {
	const sig = 0x06054b50;
	const minLen = 22;
	if (buf.length < minLen) throw new Error("不是有效的 ZIP 文件（文件过小）");
	const start = Math.max(0, buf.length - 65536 - minLen);
	for (let i = buf.length - minLen; i >= start; i--) {
		if (buf.readUInt32LE(i) === sig) return i;
	}
	throw new Error("不是有效的 ZIP 文件（未找到 EOCD）");
}

function extractZipBuffer(buf, targetDir) {
	const MAX_ENTRIES = 20000;
	const MAX_FILE_BYTES = 512 * 1024 * 1024;
	const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
	const eocd = findZipEocd(buf);
	const cdCount = buf.readUInt16LE(eocd + 10);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	let p = cdOffset;
	let totalOut = 0;
	for (let i = 0; i < cdCount; i++) {
		if (i >= MAX_ENTRIES) throw new Error("ZIP 条目数超出上限");
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOffset = buf.readUInt32LE(p + 42);
		const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
		p += 46 + nameLen + extraLen + commentLen;

		if (name.includes("..") || path.isAbsolute(name)) continue;

		const lh = localOffset;
		if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error("ZIP 局部头损坏");
		const lhNameLen = buf.readUInt16LE(lh + 26);
		const lhExtraLen = buf.readUInt16LE(lh + 28);
		const dataStart = lh + 30 + lhNameLen + lhExtraLen;
		const raw = buf.subarray(dataStart, dataStart + compSize);

		const outPath = path.resolve(targetDir, name);
		const root = path.resolve(targetDir);
		if (outPath !== root && !outPath.startsWith(root + path.sep)) continue;
		if (name.endsWith("/")) {
			mkdirSync(outPath, { recursive: true });
			continue;
		}

		mkdirSync(path.dirname(outPath), { recursive: true });
		let decompressed;
		if (method === 0) {
			decompressed = raw;
		} else if (method === 8) {
			decompressed = inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES + 1 });
		} else {
			continue;
		}
		if (decompressed.length > MAX_FILE_BYTES) throw new Error("ZIP 单文件解压超出上限");
		totalOut += decompressed.length;
		if (totalOut > MAX_TOTAL_BYTES) throw new Error("ZIP 解压总量超出上限");
		writeFileSync(outPath, decompressed);
	}
}

const DEFAULT_MODELS = [
	{
		key: "shizuku",
		name: "🌸 雫 (Shizuku - Cubism 2)",
		type: "cubism2",
		expressions: ["f01", "f02", "f03", "f04"],
		motions: ["idle", "tap_body", "pinch_in", "pinch_out", "shake", "flick_head"],
	},
	{
		key: "haru",
		name: "🌿 春 (Haru - Cubism 4)",
		type: "cubism4",
		expressions: ["f00", "f01", "f02", "f03", "f04", "f05", "f06", "f07"],
		motions: ["Idle", "Tap"],
	},
	{
		key: "hiyori",
		name: "☀️ 日和 (Hiyori - Cubism 4)",
		type: "cubism4",
		expressions: ["happy", "sad", "angry", "surprised"],
		motions: ["Idle", "TapBody"],
	},
	{
		key: "wanko",
		name: "🐶 萌柴 (Wanko - Cubism 4)",
		type: "cubism4",
		expressions: ["happy", "surprised"],
		motions: ["Idle", "TapBody"],
	},
];

export default {
	activate(host) {
		const stateFile = path.join(host.dir, "state.json");
		const customModelsFile = path.join(host.dir, "custom_models.json");
		const uploadsDir = path.join(host.dir, "uploads");
		if (!existsSync(uploadsDir)) {
			try {
				mkdirSync(uploadsDir, { recursive: true });
			} catch {}
		}

		let currentState = {
			currentModel: "shizuku",
			mode: "mouse",
		};

		async function loadState() {
			try {
				if (existsSync(stateFile)) {
					const data = JSON.parse(await fs.readFile(stateFile, "utf-8"));
					Object.assign(currentState, data);
				}
			} catch {}
		}

		async function saveState() {
			try {
				await fs.writeFile(stateFile, JSON.stringify(currentState, null, 2), "utf-8");
			} catch {}
		}

		async function loadCustomModels() {
			try {
				if (existsSync(customModelsFile)) {
					return JSON.parse(await fs.readFile(customModelsFile, "utf-8"));
				}
			} catch {}
			return [];
		}

		async function saveCustomModels(models) {
			try {
				await fs.writeFile(customModelsFile, JSON.stringify(models, null, 2), "utf-8");
			} catch {}
		}

		async function getAllModels() {
			const customs = await loadCustomModels();
			const list = [...DEFAULT_MODELS];
			for (const c of customs) {
				if (!list.some((m) => m.key === c.key)) {
					list.push(c);
				}
			}
			return list;
		}

		async function findModelConfig(dir) {
			async function scan(currentDir, currentRel, depth) {
				if (depth > 4) return null;
				let entries = [];
				try {
					entries = await fs.readdir(currentDir, { withFileTypes: true });
				} catch {
					return null;
				}
				for (const ent of entries) {
					if (ent.isFile()) {
						const lower = ent.name.toLowerCase();
						if (lower.endsWith(".model3.json") || lower.endsWith(".model.json")) {
							return {
								fullPath: path.join(currentDir, ent.name),
								relPath: (currentRel ? `${currentRel}/${ent.name}` : ent.name).replace(/\\/g, "/"),
							};
						}
					}
				}
				for (const ent of entries) {
					if (ent.isDirectory()) {
						const nextRel = currentRel ? `${currentRel}/${ent.name}` : ent.name;
						const found = await scan(path.join(currentDir, ent.name), nextRel, depth + 1);
						if (found) return found;
					}
				}
				return null;
			}
			return await scan(dir, "", 1);
		}

		async function parseModelEntry(modelKey, targetDir, foundConfig, fallbackName) {
			let content = {};
			try {
				content = JSON.parse(await fs.readFile(foundConfig.fullPath, "utf-8"));
			} catch {}
			const isCubism4 = foundConfig.relPath.toLowerCase().endsWith(".model3.json") || content.Version === 3;
			const rawName = String(
				content.name || fallbackName || path.basename(foundConfig.fullPath).replace(/\.model(?:3)?\.json$/i, ""),
			)
				.trim()
				.slice(0, 64)
				.replace(/[<>&"']/g, "");
			const expressions = [];
			const motions = [];

			if (isCubism4) {
				if (Array.isArray(content.FileReferences?.Expressions)) {
					for (const exp of content.FileReferences.Expressions) {
						if (exp.Name) expressions.push(exp.Name);
					}
				}
				if (content.FileReferences?.Motions && typeof content.FileReferences.Motions === "object") {
					for (const group of Object.keys(content.FileReferences.Motions)) {
						motions.push(group);
					}
				}
			} else {
				if (Array.isArray(content.expressions)) {
					for (const exp of content.expressions) {
						if (exp.name) expressions.push(exp.name);
					}
				}
				if (content.motions && typeof content.motions === "object") {
					for (const group of Object.keys(content.motions)) {
						motions.push(group);
					}
				}
			}

			return {
				key: modelKey,
				name: `✨ ${rawName}`,
				nameEn: `✨ ${rawName}`,
				url: `/plugins-api/live2d/uploads/${modelKey}/${foundConfig.relPath}`,
				type: isCubism4 ? "cubism4" : "cubism2",
				expressions: expressions.length > 0 ? expressions : ["happy", "sad", "angry", "surprised"],
				motions: motions.length > 0 ? motions : ["Idle", "TapBody"],
				isUploaded: true,
				scale: 1.0,
				offsetY: 0,
			};
		}

		void loadState();

		const unroutes = [];

		function route(method, routePath, handler) {
			const off = host.route(method, routePath, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					host.log("error", `[live2d] ${method} ${routePath} 失败: ${err?.message || err}`);
					if (!res.headersSent) {
						res.status(500).json({ ok: false, error: err?.message || "Internal error" });
					}
				}
			});
			unroutes.push(off);
		}

		route("GET", "/models", async (_req, res) => {
			const models = await getAllModels();
			res.json({
				ok: true,
				current: currentState.currentModel,
				mode: currentState.mode,
				models,
			});
		});

		route("GET", "/current-model", async (_req, res) => {
			res.json({
				ok: true,
				model: currentState.currentModel,
				mode: currentState.mode,
			});
		});

		route("GET", "/expressions", async (req, res) => {
			const modelKey = req.query?.model || currentState.currentModel;
			const models = await getAllModels();
			const entry = models.find((m) => m.key === modelKey) || models[0];
			res.json({
				ok: true,
				model: entry.key,
				expressions: entry.expressions || ["happy", "sad", "angry", "surprised"],
			});
		});

		route("POST", "/action", async (req, res) => {
			const payload = req.body || {};
			const action = payload.action;

			if (action === "expression") {
				const name = payload.name;
				if (!name) return res.status(400).json({ ok: false, error: "missing 'name' field" });
				host.broadcast({
					type: "live2d:action",
					action: "expression",
					name,
					duration: payload.duration || 4000,
				});
				return res.json({ ok: true, expression: name });
			}

			if (action === "message" || action === "bubble") {
				const text = payload.text;
				if (!text) return res.status(400).json({ ok: false, error: "missing 'text' field" });
				host.broadcast({
					type: "live2d:action",
					action: "bubble",
					text,
					duration: payload.duration || 4000,
					expression: payload.expression,
				});
				return res.json({ ok: true, text });
			}

			if (action === "mode") {
				const mode = payload.mode;
				if (!["mouse", "idle"].includes(mode)) {
					return res.status(400).json({ ok: false, error: "mode must be 'mouse' or 'idle'" });
				}
				currentState.mode = mode;
				void saveState();
				host.broadcast({
					type: "live2d:action",
					action: "mode",
					mode,
				});
				return res.json({ ok: true, mode });
			}

			if (action === "model_switch") {
				const model = payload.model;
				if (!model) return res.status(400).json({ ok: false, error: "missing 'model' field" });
				currentState.currentModel = model;
				void saveState();
				host.broadcast({
					type: "live2d:action",
					action: "model_switch",
					model,
				});
				return res.json({ ok: true, model });
			}

			if (action === "play_audio") {
				const url = payload.url;
				if (!url) return res.status(400).json({ ok: false, error: "missing 'url' field" });
				host.broadcast({
					type: "live2d:action",
					action: "play_audio",
					url,
					name: payload.name || "",
					volume: payload.volume,
				});
				return res.json({ ok: true, url });
			}

			if (action === "stop_audio") {
				host.broadcast({
					type: "live2d:action",
					action: "stop_audio",
				});
				return res.json({ ok: true });
			}

			if (action === "blink") {
				host.broadcast({
					type: "live2d:action",
					action: "blink",
					blinkType: payload.blinkType || "both",
				});
				return res.json({ ok: true });
			}

			res.status(400).json({ ok: false, error: `unknown action: ${action}` });
		});

		route("GET", "/uploads/*", async (req, res) => {
			const rawPath = req.pluginPath || req.url || "";
			const rel = rawPath.replace(/^\/?(?:plugins-api\/live2d\/)?uploads\//, "");
			const root = path.resolve(uploadsDir);
			const fullPath = path.resolve(root, rel);
			if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
				return res.status(403).end("Forbidden");
			}

			if (!existsSync(fullPath)) {
				return res.status(404).end("File not found");
			}
			let stat;
			try {
				stat = await fs.stat(fullPath);
			} catch {
				return res.status(404).end("File not accessible");
			}
			if (!stat.isFile()) {
				return res.status(404).end("Not a file");
			}

			const ext = path.extname(fullPath).toLowerCase();
			const mimeMap = {
				".json": "application/json; charset=utf-8",
				".png": "image/png",
				".jpg": "image/jpeg",
				".jpeg": "image/jpeg",
				".webp": "image/webp",
				".moc": "application/octet-stream",
				".moc3": "application/octet-stream",
				".mtn": "application/octet-stream",
				".motion3.json": "application/json; charset=utf-8",
				".physics3.json": "application/json; charset=utf-8",
				".cdi3.json": "application/json; charset=utf-8",
				".mp3": "audio/mpeg",
				".wav": "audio/wav",
			};

			res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
			res.setHeader("Content-Length", stat.size);
			res.setHeader("Cache-Control", "public, max-age=86400");
			const stream = createReadStream(fullPath);
			stream.pipe(res);
		});

		const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
		route("POST", "/upload-zip", async (req, res) => {
			const modelKey = "upload_" + Date.now();
			const targetDir = path.join(uploadsDir, modelKey);
			await fs.mkdir(targetDir, { recursive: true });

			const chunks = [];
			let totalBytes = 0;
			for await (const chunk of req) {
				totalBytes += chunk.length;
				if (totalBytes > MAX_ZIP_BYTES) {
					try {
						await fs.rm(targetDir, { recursive: true, force: true });
					} catch {}
					return res.status(413).json({ ok: false, error: "ZIP 包过大（> 1GB）" });
				}
				chunks.push(chunk);
			}
			const zipBuf = Buffer.concat(chunks);
			try {
				extractZipBuffer(zipBuf, targetDir);
			} catch (err) {
				try {
					await fs.rm(targetDir, { recursive: true, force: true });
				} catch {}
				return res.status(400).json({ ok: false, error: "ZIP 解压失败: " + (err.message || String(err)) });
			}

			const found = await findModelConfig(targetDir);
			if (!found) {
				try {
					await fs.rm(targetDir, { recursive: true, force: true });
				} catch {}
				return res.status(400).json({
					ok: false,
					error: "ZIP 压缩包中未检测到 .model3.json 或 .model.json 配置文件，请确认模型包格式是否正确",
				});
			}

			const rawName = req.query?.name ? decodeURIComponent(String(req.query.name)) : "";
			const entry = await parseModelEntry(modelKey, targetDir, found, rawName);

			const customs = await loadCustomModels();
			customs.push(entry);
			await saveCustomModels(customs);

			host.broadcast({ type: "live2d:custom-models-updated", models: customs });
			host.log(`[live2d] 成功导入本地模型: ${entry.name} (${modelKey})`);

			res.json({ ok: true, model: entry });
		});

		route("POST", "/upload-file", async (req, res) => {
			const query = req.query || {};
			const modelKey = String(query.key || "").replace(/[^a-zA-Z0-9_-]/g, "");
			const relPath = String(query.relPath || "");
			if (!modelKey || !relPath) {
				return res.status(400).json({ ok: false, error: "missing key or relPath" });
			}
			const root = path.resolve(uploadsDir, modelKey);
			const targetFile = path.resolve(root, relPath);
			if (targetFile !== root && !targetFile.startsWith(root + path.sep)) {
				return res.status(400).json({ ok: false, error: "relPath 越界" });
			}
			await fs.mkdir(path.dirname(targetFile), { recursive: true });

			const ws = createWriteStream(targetFile);
			req.pipe(ws);

			await new Promise((resolve, reject) => {
				ws.on("finish", resolve);
				ws.on("error", reject);
				req.on("error", reject);
			});

			res.json({ ok: true });
		});

		route("POST", "/finish-folder-upload", async (req, res) => {
			const body = req.body || {};
			const modelKey = String(body.key || "").replace(/[^a-zA-Z0-9_-]/g, "");
			const fallbackName = body.name || "";
			if (!modelKey) return res.status(400).json({ ok: false, error: "missing key" });

			const targetDir = path.join(uploadsDir, modelKey);
			const found = await findModelConfig(targetDir);
			if (!found) {
				try {
					await fs.rm(targetDir, { recursive: true, force: true });
				} catch {}
				return res.status(400).json({
					ok: false,
					error: "上传的文件夹中未找到 .model3.json 或 .model.json 配置文件",
				});
			}

			const entry = await parseModelEntry(modelKey, targetDir, found, fallbackName);
			const customs = await loadCustomModels();
			customs.push(entry);
			await saveCustomModels(customs);

			host.broadcast({ type: "live2d:custom-models-updated", models: customs });
			host.log(`[live2d] 成功导入文件夹模型: ${entry.name} (${modelKey})`);

			res.json({ ok: true, model: entry });
		});

		route("POST", "/delete-model", async (req, res) => {
			const body = req.body || {};
			const key = body.key;
			if (!key) return res.status(400).json({ ok: false, error: "missing key" });

			const customs = await loadCustomModels();
			const idx = customs.findIndex((m) => m.key === key);
			if (idx === -1) {
				return res.status(404).json({ ok: false, error: "model not found in customs" });
			}
			customs.splice(idx, 1);
			await saveCustomModels(customs);

			const uploadTarget = path.join(uploadsDir, key);
			if (existsSync(uploadTarget)) {
				try {
					await fs.rm(uploadTarget, { recursive: true, force: true });
				} catch {}
			}

			if (currentState.currentModel === key) {
				currentState.currentModel = "shizuku";
				void saveState();
				host.broadcast({ type: "live2d:action", action: "model_switch", model: "shizuku" });
			}

			host.broadcast({ type: "live2d:custom-models-updated", models: customs });
			host.log(`[live2d] 已移除自定义模型: ${key}`);

			res.json({ ok: true });
		});

		const untools = [];

		if (typeof host.registerAgentTool === "function") {
			untools.push(
				host.registerAgentTool({
					name: "live2d",
					label: "Live2D 看板娘",
					description:
						"Control on-screen Live2D companion pet: switch models, play facial expressions, speak bubbles, lip-sync audio, switch tracking mode, or blink.",
					promptSnippet: "interact with or control on-screen Live2D pet",
					promptGuidelines: [
						"Use action='list_models' to inspect available models before switching.",
						"Use action='list_expressions' to query supported emotions for the active pet.",
					],
					parameters: {
						type: "object",
						required: ["action"],
						properties: {
							action: {
								type: "string",
								enum: [
									"list_models",
									"get_current_model",
									"list_expressions",
									"play_expression",
									"show_bubble",
									"switch_mode",
									"switch_model",
									"play_audio",
									"stop_audio",
									"trigger_blink",
								],
								description: "Action to perform on the Live2D companion pet.",
							},
							model: {
								type: "string",
								description: "Model key for switch_model or list_expressions.",
							},
							name: {
								type: "string",
								description: "Expression name or alias for play_expression, or track title for play_audio.",
							},
							text: {
								type: "string",
								description: "Speech text to display in speech bubble for show_bubble.",
							},
							expression: {
								type: "string",
								description: "Optional accompanying expression for show_bubble.",
							},
							mode: {
								type: "string",
								enum: ["mouse", "idle"],
								description:
									"Target interaction mode for switch_mode: 'mouse' (eye/head follow) or 'idle' (calm breathing).",
							},
							duration: {
								type: "number",
								description: "Duration in milliseconds for play_expression or show_bubble.",
							},
							url: {
								type: "string",
								description: "Direct audio URL or base64 data URI for play_audio.",
							},
							volume: {
								type: "number",
								description: "Playback volume from 0.0 to 1.0 for play_audio (default 0.85).",
							},
							type: {
								type: "string",
								enum: ["both", "wink_left", "wink_right"],
								description: "Blink animation type for trigger_blink: 'both', 'wink_left', or 'wink_right'.",
							},
						},
					},
					async execute(_id, params) {
						const action = params?.action;
						switch (action) {
							case "list_models": {
								const models = await getAllModels();
								return JSON.stringify({
									current: currentState.currentModel,
									mode: currentState.mode,
									models: models.map((m) => ({ key: m.key, name: m.name, expressions: m.expressions })),
								});
							}
							case "get_current_model": {
								const models = await getAllModels();
								const entry = models.find((m) => m.key === currentState.currentModel) || models[0];
								return JSON.stringify({
									current: currentState.currentModel,
									mode: currentState.mode,
									modelName: entry.name,
									expressions: entry.expressions || [],
								});
							}
							case "list_expressions": {
								const targetKey = params?.model || currentState.currentModel;
								const models = await getAllModels();
								const entry = models.find((m) => m.key === targetKey) || models[0];
								return JSON.stringify({
									model: entry.key,
									expressions: entry.expressions || ["happy", "sad", "angry", "surprised"],
								});
							}
							case "play_expression": {
								const name = params?.name || "happy";
								const duration = params?.duration || 4000;
								host.broadcast({
									type: "live2d:action",
									action: "expression",
									name,
									duration,
								});
								return `Live2D pet played expression: ${name}`;
							}
							case "show_bubble": {
								const text = params?.text || "";
								const expression = params?.expression;
								const duration = params?.duration || 4500;
								host.broadcast({
									type: "live2d:action",
									action: "bubble",
									text,
									expression,
									duration,
								});
								return `Live2D pet says: ${text}`;
							}
							case "switch_mode": {
								const mode = params?.mode;
								if (mode !== "mouse" && mode !== "idle") {
									return `Invalid mode: ${mode}. Must be 'mouse' or 'idle'.`;
								}
								currentState.mode = mode;
								void saveState();
								host.broadcast({
									type: "live2d:action",
									action: "mode",
									mode,
								});
								return `Live2D pet mode switched to: ${mode}`;
							}
							case "switch_model": {
								let model = params?.model;
								if (model === "koharu") model = "haru";
								const models = await getAllModels();
								const found = models.find((m) => m.key === model);
								if (!found) {
									return `Model '${model}' not found. Available models: ${models.map((m) => m.key).join(", ")}`;
								}
								currentState.currentModel = model;
								void saveState();
								host.broadcast({
									type: "live2d:action",
									action: "model_switch",
									model,
								});
								return `Live2D model switched to: ${found.name}`;
							}
							case "play_audio": {
								const url = params?.url;
								if (!url) return "Error: 'url' parameter is required for action 'play_audio'.";
								const name = params?.name || "";
								const volume = typeof params?.volume === "number" ? params.volume : 0.85;
								host.broadcast({
									type: "live2d:action",
									action: "play_audio",
									url,
									name,
									volume,
								});
								return `Playing audio on Live2D pet with lip sync: ${name || url}`;
							}
							case "stop_audio": {
								host.broadcast({
									type: "live2d:action",
									action: "stop_audio",
								});
								return "Live2D pet audio playback stopped.";
							}
							case "trigger_blink": {
								const blinkType = params?.type || "both";
								host.broadcast({
									type: "live2d:action",
									action: "blink",
									blinkType,
								});
								return `Live2D pet triggered ${blinkType} eye animation.`;
							}
							default:
								return `Unknown action: '${action}'. Supported actions: list_models, get_current_model, list_expressions, play_expression, show_bubble, switch_mode, switch_model, play_audio, stop_audio, trigger_blink.`;
						}
					},
				}),
			);
		}

		const unmarkers = [];
		if (typeof host.registerMarker === "function") {
			const off = host.registerMarker({
				name: "live2d",
				label: "Live2D 看板娘心声",
				guidance: [
					"- Live2D companion inner voice: [[live2d:thought:<text>]] (express inner feelings/monologue above the Live2D model; optional parameters: emotion=<happy|sad|angry|surprised|blush|wink|neutral>, duration=<ms>).",
				],
				getGuidance(lang = "en") {
					if (lang === "zh") {
						return [
							"- Live2D 看板娘心声：[[live2d:thought:<心声内容>]]（在看板娘上方浮现心声气泡；可选参数：emotion=<happy|sad|angry|surprised|blush|wink|neutral>，duration=<毫秒>）。",
						];
					}
					return [
						"- Live2D companion inner voice: [[live2d:thought:<text>]] (express inner feelings/monologue above the Live2D model; optional parameters: emotion=<happy|sad|angry|surprised|blush|wink|neutral>, duration=<ms>).",
					];
				},
				async apply(token, _ctx, _state, lang = "en") {
					const op = String(token?.op || "thought").toLowerCase();
					const isThought = op === "thought" || op === "heart" || op === "mind" || op === "inner";
					let text = token?.kwargs?.text || token?.kwargs?.msg || token?.kwargs?.content || "";
					if (!text && Array.isArray(token?.args) && token.args.length > 0) {
						text = token.args.join(", ").trim();
					}
					if (!text) {
						return {
							applied: false,
							error: lang === "zh" ? "live2d 标记缺少心声内容" : "live2d marker requires message text",
						};
					}
					const expression = token?.kwargs?.emotion || token?.kwargs?.expression || token?.kwargs?.exp || "";
					const duration =
						Number(token?.kwargs?.duration) > 0 ? Number(token?.kwargs?.duration) : isThought ? 5000 : 4500;

					host.broadcast({
						type: "live2d:action",
						action: isThought ? "thought" : "bubble",
						text,
						expression: expression || undefined,
						duration,
						thought: isThought,
					});

					return {
						applied: true,
						feedback: isThought ? `Live2D inner thought: ${text}` : `Live2D speech: ${text}`,
					};
				},
			});
			if (typeof off === "function") unmarkers.push(off);
		}

		const unevents = [];
		if (typeof host.onRunEvent === "function") {
			const off = host.onRunEvent((event) => {
				const type = event?.type;
				if (type === "run_start") {
					host.broadcast({ type: "live2d:agent-event", status: "thinking" });
				} else if (type === "run_end") {
					const hasError = Boolean(event?.error);
					host.broadcast({ type: "live2d:agent-event", status: hasError ? "error" : "done" });
				}
			});
			unevents.push(off);
		}

		const unset = [];
		if (typeof host.onSettingsChanged === "function") {
			const off = host.onSettingsChanged((settings) => {
				host.broadcast({ type: "live2d:settings-updated", settings });
			});
			unset.push(off);
		}

		host.log("Live2D 看板娘插件已成功激活");

		return () => {
			for (const u of unroutes) {
				try {
					u();
				} catch {}
			}
			for (const u of untools) {
				try {
					u();
				} catch {}
			}
			for (const u of unmarkers) {
				try {
					u();
				} catch {}
			}
			for (const u of unevents) {
				try {
					u();
				} catch {}
			}
			for (const u of unset) {
				try {
					u();
				} catch {}
			}
		};
	},
};
