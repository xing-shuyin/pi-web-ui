import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REMOTE_TRANSCRIBE_TIMEOUT_MS = 120_000;
const MAX_REMOTE_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_LOCAL_AUDIO_BYTES = 15 * 1024 * 1024;
const TRANSFORMERS_PKG = "@xenova/transformers";
const TRANSFORMERS_SPEC = `${TRANSFORMERS_PKG}@2.17.2`;

export const LOCAL_MODELS = {
	tiny: "Xenova/whisper-tiny",
	base: "Xenova/whisper-base",
	small: "Xenova/whisper-small",
};

export function resolveLocalModel(size) {
	const s = typeof size === "string" ? size.trim().toLowerCase() : "";
	return Object.prototype.hasOwnProperty.call(LOCAL_MODELS, s) ? LOCAL_MODELS[s] : null;
}

function str(v) {
	return typeof v === "string" ? v.trim() : "";
}

export function whisperLang(lang) {
	const l = str(lang).toLowerCase();
	if (l.startsWith("zh")) return "zh";
	if (l.startsWith("en")) return "en";
	if (l.startsWith("ja")) return "ja";
	if (l.startsWith("ko")) return "ko";
	if (l.startsWith("fr")) return "fr";
	if (l.startsWith("de")) return "de";
	if (l.startsWith("es")) return "es";
	if (l.startsWith("ru")) return "ru";
	if (l.startsWith("it")) return "it";
	if (l.startsWith("pt")) return "pt";
	return "";
}

export const DEFAULT_INITIAL_PROMPTS = {
	zh: "以下是普通话的句子，请使用简体中文。",
	"zh-traditional": "以下是國語的句子，請使用臺灣繁體中文。",
	en: "This is a sentence in English. Please transcribe it accurately.",
	ja: "以下は日本語の文です。正確に書き起こしてください。",
	ko: "다음은 한국어 문장입니다. 정확하게 받아써 주세요.",
};

export function resolveInitialPrompt(lang, cfg = {}) {
	const custom = typeof cfg?.initialPrompt === "string" ? cfg.initialPrompt.trim() : "";
	if (custom) return custom.slice(0, 500);
	const l = str(lang).toLowerCase();
	if (l.startsWith("zh")) {
		const v = str(cfg?.zhVariant || "simplified").toLowerCase();
		if (v.startsWith("trad")) return DEFAULT_INITIAL_PROMPTS["zh-traditional"];
		return DEFAULT_INITIAL_PROMPTS.zh;
	}
	for (const k of ["en", "ja", "ko"]) if (l.startsWith(k)) return DEFAULT_INITIAL_PROMPTS[k];
	return "";
}

export function whisperFullLang(lang) {
	const l = str(lang).toLowerCase();
	if (l.startsWith("zh")) return "chinese";
	if (l.startsWith("en")) return "english";
	if (l.startsWith("ja")) return "japanese";
	if (l.startsWith("ko")) return "korean";
	if (l.startsWith("fr")) return "french";
	if (l.startsWith("de")) return "german";
	if (l.startsWith("es")) return "spanish";
	if (l.startsWith("ru")) return "russian";
	if (l.startsWith("it")) return "italian";
	if (l.startsWith("pt")) return "portuguese";
	return "";
}

export function joinUrl(base, path) {
	return `${str(base).replace(/\/+$/, "")}${path}`;
}

export function pkgEntryCandidates(pkg) {
	const out = [];
	const push = (v) => {
		const s = str(v);
		if (s && !out.includes(s)) out.push(s);
	};
	const p = pkg && typeof pkg === "object" ? pkg : {};
	const root = p.exports;
	const dot = typeof root === "string" ? root : root && typeof root === "object" ? root["."] : undefined;
	if (typeof dot === "string") push(dot);
	else if (dot && typeof dot === "object") {
		for (const cond of ["import", "module", "default", "require", "node", "browser"]) push(dot[cond]);
	}
	push(p.module);
	push(p.main);
	for (const guess of ["dist/transformers.js", "dist/transformers.mjs", "dist/transformers.cjs"]) push(guess);
	return out;
}

export function hfEndpointHost(setting, env = process.env.HF_ENDPOINT) {
	const s = str(setting || env).replace(/\/+$/, "");
	return /^https?:\/\/\S+$/i.test(s) ? s : "";
}

export function applyHfEndpoint(transformersEnv, endpoint) {
	if (!transformersEnv || !endpoint) return transformersEnv;
	transformersEnv.remoteHost = endpoint;
	return transformersEnv;
}

export function ensureSharpStub(fromFile) {
	let req;
	try {
		req = createRequire(fromFile);
	} catch {
		return false;
	}
	let sharpEntry = "";
	try {
		sharpEntry = req.resolve("sharp");
	} catch {
		let cur = dirname(fromFile);
		for (;;) {
			const pkgJson = join(cur, "node_modules", "sharp", "package.json");
			if (existsSync(pkgJson)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
					const main = str(pkg?.main) || "lib/index.js";
					const cand = join(cur, "node_modules", "sharp", main);
					if (existsSync(cand)) {
						sharpEntry = cand;
						break;
					}
				} catch {}
			}
			const up = dirname(cur);
			if (!up || up === cur) break;
			cur = up;
		}
	}
	if (!sharpEntry) return false;
	try {
		req(sharpEntry);
		return false;
	} catch {
		const stub = function sharpStub() {
			throw new Error("sharp native binary is unavailable (stubbed by voice-input for audio-only pipeline)");
		};
		req.cache[sharpEntry] = {
			id: sharpEntry,
			filename: sharpEntry,
			loaded: true,
			exports: stub,
		};
		const nativeWrapper = join(dirname(sharpEntry), "sharp.js");
		if (existsSync(nativeWrapper)) {
			req.cache[nativeWrapper] = {
				id: nativeWrapper,
				filename: nativeWrapper,
				loaded: true,
				exports: stub,
			};
		}
		return true;
	}
}

export function hasCachedModelOnDisk(cacheDir, modelId) {
	const id = str(modelId);
	if (!cacheDir || !id) return false;
	try {
		const modelDir = join(cacheDir, ...id.split("/"));
		if (!existsSync(join(modelDir, "config.json"))) return false;
		const onnxDir = join(modelDir, "onnx");
		if (!existsSync(onnxDir)) return false;
		const files = readdirSync(onnxDir);
		return files.some((f) => f.endsWith(".onnx"));
	} catch {
		return false;
	}
}

export function resampleLinear(samples, fromRate, toRate) {
	const src = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
	if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
		throw new Error("采样率非法");
	}
	if (src.length === 0) return new Float32Array(0);
	if (fromRate === toRate) return Float32Array.from(src);
	const outLen = Math.max(1, Math.round((src.length * toRate) / fromRate));
	const out = new Float32Array(outLen);
	const ratio = src.length / outLen;
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const i0 = Math.floor(pos);
		const i1 = Math.min(i0 + 1, src.length - 1);
		const frac = pos - i0;
		out[i] = src[i0] * (1 - frac) + src[i1] * frac;
	}
	return out;
}

function readAscii(view, offset, len) {
	let s = "";
	for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
	return s;
}

export function decodeWav16k(buf) {
	const u8 = Buffer.isBuffer(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
	if (!(u8 instanceof Uint8Array) || u8.length < 44) throw new Error("音频不是有效的 WAV（太短）");
	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
		throw new Error("音频不是有效的 WAV（缺 RIFF/WAVE 头）");
	}
	let audioFormat = 0;
	let channels = 0;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let dataStart = -1;
	let dataLen = 0;
	let off = 12;
	while (off + 8 <= u8.length) {
		const id = readAscii(view, off, 4);
		const size = view.getUint32(off + 4, true);
		if (id === "fmt " && size >= 16) {
			audioFormat = view.getUint16(off + 8, true);
			channels = view.getUint16(off + 10, true);
			sampleRate = view.getUint32(off + 12, true);
			bitsPerSample = view.getUint16(off + 22, true);
		} else if (id === "data") {
			dataStart = off + 8;
			dataLen = Math.min(size, u8.length - dataStart);
		}
		off += 8 + size + (size % 2);
	}
	if (audioFormat !== 1 && audioFormat !== 3)
		throw new Error(`WAV 编码不支持（format=${audioFormat}，只要 PCM/Float）`);
	if (channels < 1 || channels > 8) throw new Error("WAV 声道数异常");
	if (!Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 192000) throw new Error("WAV 采样率异常");
	if (![8, 16, 24, 32].includes(bitsPerSample)) throw new Error(`WAV 位深不支持（${bitsPerSample}bit）`);
	if (audioFormat === 3 && bitsPerSample !== 32) throw new Error("Float WAV 只要 32bit");
	if (dataStart < 0 || dataLen <= 0) throw new Error("WAV 里没有采样数据");
	const bytesPerSample = bitsPerSample / 8;
	const frames = Math.floor(dataLen / (bytesPerSample * channels));
	if (frames <= 0) throw new Error("WAV 里没有采样数据");
	const mono = new Float32Array(frames);
	const dv = new DataView(u8.buffer, u8.byteOffset + dataStart, dataLen - (dataLen % (bytesPerSample * channels)));
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) {
			const p = (f * channels + c) * bytesPerSample;
			let v;
			if (audioFormat === 3) v = dv.getFloat32(p, true);
			else if (bitsPerSample === 8) v = (dv.getUint8(p) - 128) / 128;
			else if (bitsPerSample === 16) v = dv.getInt16(p, true) / 32768;
			else if (bitsPerSample === 24) {
				const b0 = dv.getUint8(p);
				const b1 = dv.getUint8(p + 1);
				const b2 = dv.getInt8(p + 2);
				v = (b2 * 65536 + b1 * 256 + b0) / 8388608;
			} else v = dv.getInt32(p, true) / 2147483648;
			sum += v;
		}
		mono[f] = sum / channels;
	}
	return resampleLinear(mono, sampleRate, 16000);
}

export default {
	activate(host) {
		const dir = host.dir;
		const cacheDir = join(dir, "whisper-cache");
		let cfg = host.getSettings?.() ?? {};
		const offSettings = host.onSettingsChanged?.((v) => {
			cfg = v && typeof v === "object" ? v : {};
			syncTranscribeTool();
		});

		const local = {
			installing: false,
			progress: null,
			phase: "",
			error: "",
			pipe: null,
			loadedModel: "",
			transcribeBusy: false,
		};
		let installFlight = null;

		const engine = () => {
			const e = str(cfg.engine).toLowerCase();
			return e === "local" || e === "remote" ? e : "auto";
		};
		const wantedModelId = () => resolveLocalModel(cfg.localModel) ?? LOCAL_MODELS.base;
		const remoteReady = () => Boolean(str(cfg.transcribeUrl) && str(cfg.transcribeKey));
		const installedModels = () => {
			try {
				const v = host.storage.get("whisperModels", {});
				return v && typeof v === "object" ? v : {};
			} catch {
				return {};
			}
		};
		const localReady = () => {
			const id = wantedModelId();
			if (installedModels()[id]) return true;
			if (hasCachedModelOnDisk(cacheDir, id)) {
				const prev = installedModels();
				prev[id] = true;
				try {
					host.storage.set("whisperModels", prev);
				} catch {}
				return true;
			}
			return false;
		};

		const localStatus = () => ({
			installing: local.installing,
			progress: local.progress,
			phase: local.phase,
			error: local.error,
			ready: localReady(),
			model: wantedModelId(),
			loaded: Boolean(local.pipe) && local.loadedModel === wantedModelId(),
		});

		const safe = (method, path, handler) =>
			host.route(method, path, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					const status = Number(err?.statusCode ?? 500);
					const msg = err instanceof Error ? err.message : String(err);
					host.log(`voice-input ${method} ${path} 失败:`, err);
					if (!res.headersSent)
						res.status(status >= 400 && status < 600 ? status : 500).json({ error: msg || "internal error" });
					else res.end();
					if (status === 413) req.destroy();
				}
			});

		async function readRaw(req) {
			const tooLarge = () =>
				Object.assign(new Error(`录音超过 ${MAX_REMOTE_AUDIO_BYTES / 1048576}MB 上限`), { statusCode: 413 });
			const b = req.body;
			if (b && typeof b === "object" && typeof b.dataBase64 === "string") {
				const buf = Buffer.from(b.dataBase64, "base64");
				if (buf.length > MAX_REMOTE_AUDIO_BYTES) throw tooLarge();
				return buf;
			}
			if (Buffer.isBuffer(b)) {
				if (b.length > MAX_REMOTE_AUDIO_BYTES) throw tooLarge();
				return b;
			}
			return new Promise((resolve, reject) => {
				const chunks = [];
				let total = 0;
				let done = false;
				const finish = (err, val) => {
					if (done) return;
					done = true;
					if (err) {
						req.pause();
						req.removeListener("data", onData);
						reject(err);
					} else resolve(val);
				};
				const onData = (c) => {
					const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
					total += chunk.length;
					if (total > MAX_REMOTE_AUDIO_BYTES) return finish(tooLarge());
					chunks.push(chunk);
				};
				req.on("data", onData);
				req.on("end", () => finish(null, Buffer.concat(chunks)));
				req.on("error", (err) => finish(err));
			});
		}

		function transformersEntry() {
			const pkgDir = join(dir, "node_modules", ...TRANSFORMERS_PKG.split("/"));
			try {
				const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
				for (const rel of pkgEntryCandidates(pkg)) {
					const abs = join(pkgDir, rel);
					if (existsSync(abs)) return abs;
				}
			} catch {}
			return createRequire(join(dir, "index.mjs")).resolve(TRANSFORMERS_PKG);
		}

		async function importTransformers() {
			const ok = await host.ensureDeps?.([TRANSFORMERS_SPEC], {
				onProgress: (m) => {
					local.phase = str(m) || "正在安装本地语音运行时…";
				},
			});
			if (!ok) throw new Error("本地语音运行时安装失败（npm install 没跑通，请检查网络后重试）");
			let entry;
			try {
				entry = transformersEntry();
			} catch {
				throw new Error("本地语音运行时装上了但解析不到入口（node_modules 可能损坏，删了重装）");
			}
			ensureSharpStub(entry);
			const mod = await import(pathToFileURL(entry).href);
			if (!mod || !mod.pipeline) throw new Error("本地语音运行时加载失败（依赖装上了但 import 不到）");
			mod.env.cacheDir = cacheDir;
			applyHfEndpoint(mod.env, hfEndpointHost(cfg.hfEndpoint));
			return mod;
		}

		async function runInstall(modelId) {
			local.installing = true;
			local.progress = null;
			local.error = "";
			try {
				local.phase = "正在安装本地语音运行时（首次约几分钟）…";
				const tf = await importTransformers();
				local.phase = `正在下载语音模型（${modelId}，首次约几百 MB）…`;
				const seen = new Map();
				const pipe = await tf.pipeline("automatic-speech-recognition", modelId, {
					progress_callback: (p) => {
						try {
							if (!p || typeof p !== "object") return;
							if (p.status === "progress" && typeof p.progress === "number") {
								seen.set(String(p.file ?? ""), {
									loaded: Number(p.loaded) || 0,
									total: Number(p.total) || 0,
								});
								let l = 0;
								let t = 0;
								for (const v of seen.values()) {
									l += v.loaded;
									t += v.total;
								}
								if (t > 0) local.progress = Math.min(99, Math.round((l / t) * 100));
							} else if (p.status === "done") {
								const k = String(p.file ?? "");
								if (seen.has(k)) {
									const v = seen.get(k);
									seen.set(k, { loaded: Math.max(v.loaded, v.total), total: v.total });
								}
							}
						} catch {}
					},
				});
				if (!pipe) throw new Error("语音模型加载返回空");
				local.phase = "预热…";
				try {
					await pipe(new Float32Array(16000 * 3), { language: "english", task: "transcribe" });
				} catch {}
				try {
					if (local.pipe && local.loadedModel !== modelId) {
						await local.pipe.model?.dispose?.();
					}
				} catch {}
				local.pipe = pipe;
				local.loadedModel = modelId;
				const prev = installedModels();
				prev[modelId] = true;
				try {
					host.storage.set("whisperModels", prev);
				} catch {}
				local.progress = 100;
				local.phase = "完成";
				host.log(`voice-input 本地模型就绪: ${modelId}`);
			} catch (err) {
				local.error = err instanceof Error ? err.message : String(err);
				host.log("voice-input 本地安装失败:", err);
			} finally {
				local.installing = false;
				installFlight = null;
			}
		}

		async function getPipe(modelId) {
			if (local.pipe && local.loadedModel === modelId) return local.pipe;
			const tf = await importTransformers();
			try {
				if (local.pipe) {
					await local.pipe.model?.dispose?.();
				}
			} catch {}
			local.pipe = await tf.pipeline("automatic-speech-recognition", modelId);
			local.loadedModel = modelId;
			return local.pipe;
		}

		async function transcribeLocal(audio, lang) {
			const modelId = wantedModelId();
			let samples;
			try {
				samples = decodeWav16k(audio);
			} catch (err) {
				const e = new Error(`本地引擎只要 WAV：${err instanceof Error ? err.message : String(err)}`);
				e.statusCode = 415;
				throw e;
			}
			if (samples.length < 1600) {
				const e = new Error("录音太短（不到 0.1 秒），请按住说完再结束");
				e.statusCode = 400;
				throw e;
			}
			const capped = samples.length > 16000 * 480 ? samples.slice(0, 16000 * 480) : samples;
			const pipe = await getPipe(modelId);
			const fullLang = whisperFullLang(lang);
			const initialPrompt = resolveInitialPrompt(lang, cfg);
			const generateKwargs = {};
			if (initialPrompt) {
				generateKwargs.initial_prompt = initialPrompt;
				generateKwargs.prompt = initialPrompt;
			}
			const out = await pipe(capped, {
				language: fullLang || undefined,
				task: "transcribe",
				...(initialPrompt ? { initial_prompt: initialPrompt, prompt: initialPrompt } : {}),
				generate_kwargs: generateKwargs,
				chunk_length_s: 30,
				stride_length_s: 5,
			});
			const text = str(out?.text);
			if (!text) {
				const e = new Error("本地转写返回空（可能全是静音），请靠近麦克风再说一次");
				e.statusCode = 502;
				throw e;
			}
			return text;
		}

		async function transcribeRemote(audio, mime, lang) {
			const baseUrl = str(cfg.transcribeUrl);
			const apiKey = str(cfg.transcribeKey);
			if (!baseUrl || !apiKey) {
				const e = new Error(
					"服务端转写未配置：设置面板 → 界面插件 → 语音输入 → 填写「转写接口基址」与「密钥」，或一键安装本地 Whisper",
				);
				e.statusCode = 501;
				throw e;
			}
			if (audio.length > MAX_REMOTE_AUDIO_BYTES) {
				const e = new Error(`录音过大（${(audio.length / 1048576).toFixed(1)}MB > 25MB），请分段录制`);
				e.statusCode = 413;
				throw e;
			}
			const ext =
				mime.includes("mp4") || mime.includes("m4a")
					? "m4a"
					: mime.includes("ogg")
						? "ogg"
						: mime.includes("wav")
							? "wav"
							: "webm";
			const wl = whisperLang(lang);
			const form = new FormData();
			form.set("file", new Blob([audio], { type: mime }), `voice.${ext}`);
			form.set("model", str(cfg.transcribeModel) || "whisper-1");
			if (wl) form.set("language", wl);
			const prompt = resolveInitialPrompt(lang, cfg);
			if (prompt) form.set("prompt", prompt);
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), REMOTE_TRANSCRIBE_TIMEOUT_MS);
			let r;
			try {
				r = await fetch(joinUrl(baseUrl, "/audio/transcriptions"), {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}` },
					body: form,
					signal: ctrl.signal,
				});
			} catch (err) {
				const e = new Error(
					err?.name === "AbortError" ? "转写超时（120s），请分段录制" : `转写接口 unreachable：${err.message}`,
				);
				e.statusCode = 502;
				throw e;
			} finally {
				clearTimeout(timer);
			}
			if (!r.ok) {
				const body = (await r.text().catch(() => "")).slice(0, 500);
				const e = new Error(`转写接口报错 ${r.status}：${body || r.statusText}`);
				e.statusCode = 502;
				throw e;
			}
			const data = await r.json().catch(() => ({}));
			return str(data?.text);
		}

		const offGet = safe("GET", "/settings", async (_req, res) => {
			res.json({
				lang: str(cfg.lang) || "zh-CN",
				serverFallback: cfg.serverFallback !== false,
				engine: engine(),
				localModel: str(cfg.localModel) || "base",
				serverReady: remoteReady(),
				localReady: localReady(),
			});
		});

		const offStatus = safe("GET", "/local-status", async (_req, res) => {
			res.json(localStatus());
		});

		const offEngine = safe("POST", "/engine", async (req, res) => {
			const want = str((req.body ?? {}).engine).toLowerCase();
			if (!["auto", "local", "remote"].includes(want)) {
				res.status(400).json({ error: `未知的转写引擎：${want || "（空）"}` });
				return;
			}
			const stored = host.storage.get("settings", {});
			const next = stored && typeof stored === "object" ? { ...stored } : {};
			next.engine = want;
			host.storage.set("settings", next);
			cfg = { ...cfg, engine: want };
			res.json({ ok: true, engine: want });
		});

		const offInstall = safe("POST", "/local-install", async (req, res) => {
			const eng = engine();
			if (eng === "remote") {
				res.status(409).json({ error: "当前引擎是「仅远端」：先把「转写引擎」切到自动或本地再安装" });
				return;
			}
			let body = req.body;
			if (!body || typeof body !== "object") body = {};
			const modelId = resolveLocalModel(body.model) ?? wantedModelId();
			if (local.installing) {
				res.json({ started: true, deduped: true, ...localStatus() });
				return;
			}
			if (!existsSync(dir)) {
				res.status(500).json({ error: "插件目录不可写，无法安装" });
				return;
			}
			local.phase = "准备…";
			installFlight = runInstall(modelId);
			void installFlight;
			res.status(202).json({ started: true, ...localStatus() });
		});

		const offUninstall = safe("DELETE", "/local", async (_req, res) => {
			if (local.installing) {
				res.status(409).json({ error: "正在安装中，请等它装完再卸" });
				return;
			}
			try {
				if (local.pipe) {
					await local.pipe.model?.dispose?.();
				}
			} catch {}
			local.pipe = null;
			local.loadedModel = "";
			let freed = false;
			try {
				await rm(cacheDir, { recursive: true, force: true });
				freed = true;
			} catch (err) {
				host.log("voice-input 删模型缓存失败:", err);
			}
			try {
				host.storage.delete("whisperModels");
			} catch {}
			local.progress = null;
			local.phase = "";
			local.error = "";
			res.json({ ok: true, freed });
		});

		async function runTranscribe(audio, mime, lang) {
			const eng = engine();
			const tryLocal = eng !== "remote" && localReady();
			const tryRemote = eng !== "local" && remoteReady();

			const fail = (msg, code) => {
				const e = new Error(msg);
				e.statusCode = code;
				return e;
			};

			if (eng !== "remote" && tryLocal) {
				if (audio.length > MAX_LOCAL_AUDIO_BYTES) {
					if (eng === "auto" && tryRemote) {
						host.log("voice-input 音频超过本地 Whisper 上限（>8分钟），切远端兜底");
						return { text: await transcribeRemote(audio, mime, lang), engine: "remote" };
					}
					throw fail("音频太长（>8分钟），请分段", 413);
				}
				if (local.transcribeBusy) {
					if (eng === "auto" && tryRemote) {
						host.log("voice-input 本地 Whisper 正忙，切远端兜底");
						return { text: await transcribeRemote(audio, mime, lang), engine: "remote" };
					}
					throw fail("本地正在转写上一段，稍等几秒再试", 429);
				}
				local.transcribeBusy = true;
				try {
					return { text: await transcribeLocal(audio, lang), engine: "local" };
				} catch (err) {
					const status = err?.statusCode;
					if (eng === "auto" && tryRemote && status !== 415 && status !== 400) {
						host.log("voice-input 本地转写失败，切远端兜底:", err instanceof Error ? err.message : err);
					} else {
						throw err;
					}
				} finally {
					local.transcribeBusy = false;
				}
			} else if (eng === "local") {
				throw fail("本地 Whisper 还没装：麦克风浮层里点「一键安装本地 Whisper」", 501);
			}

			if (!tryRemote) {
				throw fail(
					localReady()
						? "转写失败：请重试"
						: "服务端转写没得用：要么一键安装本地 Whisper（麦克风浮层里有按钮），要么在设置里填远端转写接口",
					501,
				);
			}
			return { text: await transcribeRemote(audio, mime, lang), engine: "remote" };
		}

		const offPost = safe("POST", "/transcribe", async (req, res) => {
			const audio = await readRaw(req);
			if (!audio.length) {
				res.status(400).json({ error: "请求体为空（没有收到录音）" });
				return;
			}
			const mime = str(req.headers?.["content-type"]).split(";")[0] || "audio/wav";
			const lang = str(req.query?.lang) || str(cfg.lang) || "zh-CN";
			try {
				res.json(await runTranscribe(audio, mime, lang));
			} catch (err) {
				res.status(err?.statusCode || 502).json({ error: err instanceof Error ? err.message : String(err) });
			}
		});

		function audioMimeOf(name) {
			const ext = String(name).toLowerCase().split(".").pop();
			if (ext === "wav") return "audio/wav";
			if (ext === "mp3") return "audio/mpeg";
			if (ext === "m4a" || ext === "mp4") return "audio/mp4";
			if (ext === "ogg" || ext === "oga" || ext === "opus") return "audio/ogg";
			if (ext === "webm") return "audio/webm";
			if (ext === "flac") return "audio/flac";
			if (ext === "aac") return "audio/aac";
			return "";
		}

		function looksLikeWav(buf) {
			try {
				const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
				return b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE";
			} catch {
				return false;
			}
		}

		let offTranscribeTool = null;

		function syncTranscribeTool() {
			const want = cfg.transcribeTool !== false;
			if (want && !offTranscribeTool) {
				offTranscribeTool = host.registerAgentTool({
					name: "transcribe_audio",
					label: "转写音频文件",
					description:
						"Transcribe an audio file in the workspace (a meeting recording, a voice memo, the audio track of a video) into text, so you can read what was said — you cannot listen to audio yourself. " +
						"WAV works with the free offline local Whisper; other formats (mp3/m4a/ogg/webm) need the remote endpoint configured in this plugin's settings. " +
						"Local transcription is capped at ~8 minutes per call — split longer recordings first. Returns the transcript plus which engine produced it.",
					promptSnippet: "transcribe an audio file to text (WAV offline)",
					parameters: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description:
									"Path to the audio file, relative to the workspace (absolute paths inside the workspace also work). Outside the workspace it is refused.",
							},
							lang: {
								type: "string",
								description: "Spoken-language hint such as zh-CN / en-US. Defaults to the plugin's setting.",
							},
						},
						required: ["path"],
					},
					async execute(_toolCallId, params) {
						const rel = str(params?.path).trim();
						if (!rel) return "缺少 path 参数：请给出工作区内的音频文件路径。";
						const base = rel.split(/[\\/]/).pop() || rel;
						const absolute = /^([a-zA-Z]:[\\/]|[\\/]{1,2})/.test(rel);
						let buf;
						try {
							buf = absolute ? await host.fs.readPath(rel) : await host.fs.read(rel);
						} catch (err) {
							return `读不到 ${rel}：${err instanceof Error ? err.message : String(err)}（只能读工作区内的文件；工作区外的目录请先加为工作区根）`;
						}
						if (!buf?.length) return `${base} 是空文件。`;

						const isWav = looksLikeWav(buf);
						if (!isWav && !remoteReady()) {
							return (
								`${base} 不是 WAV，而本地 Whisper 只能解码 WAV（这台机器没有 ffmpeg）。两条出路：` +
								`① 让用户在「设置 → 界面插件 → 语音输入」里填好「转写接口基址 / 密钥」，用远端接口转非 WAV 音频；` +
								`② 先把这段音频转成 16k 单声道 WAV 再来读。`
							);
						}
						const mime = isWav ? "audio/wav" : audioMimeOf(base) || "application/octet-stream";
						const lang = str(params?.lang) || str(cfg.lang) || "zh-CN";
						try {
							const out = isWav
								? await runTranscribe(buf, "audio/wav", lang)
								: { text: await transcribeRemote(buf, mime, lang), engine: "remote" };
							const text = str(out.text).trim();
							return {
								content: [{ type: "text", text: text || "（转写结果为空——可能整段没有语音）" }],
								details: { engine: out.engine, path: rel, chars: text.length },
							};
						} catch (err) {
							return `转写 ${base} 失败：${err instanceof Error ? err.message : String(err)}`;
						}
					},
				});
				host.log("voice-input AI 工具已注册：transcribe_audio");
			} else if (!want && offTranscribeTool) {
				try {
					offTranscribeTool();
				} catch {}
				offTranscribeTool = null;
				host.log("voice-input AI 工具已下架：transcribe_audio");
			}
		}

		syncTranscribeTool();

		host.log("voice-input activated");
		return () => {
			try {
				offTranscribeTool?.();
				offTranscribeTool = null;
			} catch {}
			for (const off of [offGet, offStatus, offEngine, offInstall, offUninstall, offPost]) {
				try {
					off();
				} catch {}
			}
			try {
				offSettings?.();
			} catch {}
			host.log("voice-input deactivated");
		};
	},
};
