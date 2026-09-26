/**
 * voice-input 服务端入口 —— 语音输入插件的服务端一半。
 *
 * 两条转写引擎（`engine` 设置，默认 auto）：
 *   local  本地 Whisper（transformers.js + ONNX，CPU 跑，零 key）：
 *          点「一键安装」后经 host.ensureDeps 装运行时、下载模型到本插件目录
 *          （<dataDir>/plugins/voice-input/whisper-cache），转写全程不出本机；
 *   remote 远端 OpenAI 兼容接口（POST {base}/audio/transcriptions）。
 *   auto   本地装好了用本地，否则用远端（配了才可用）。
 *
 * 客户端录音统一发 16kHz 单声道 16-bit WAV（AudioWorklet 现场编码，
 * 无需服务端装 ffmpeg）；远端接口同时兼容其它音频 mime。
 *
 * 路由（挂载在 `/plugins-api/voice-input/*`，需 manifest `permissions` 含 `http`）：
 *   GET    /settings      → { lang, serverFallback, engine, localModel,
 *                             serverReady, localReady, localModels }（绝不下发密钥）
 *   POST   /engine        → 改「转写引擎」（body {engine: auto|local|remote}，
 *                             浮层里的切换面板用；白名单校验后写回声明式设置）
 *   POST   /transcribe    → 音频字节（WAV 最佳，?lang= 可选），回 { text, engine }
 *   GET    /local-status  → { installing, progress, error, ready, models, loaded }
 *   POST   /local-install → {started:true}（body {model?}；单飞，后台慢慢装）
 *   DELETE /local         → 删模型缓存（node_modules 留着，重装快）
 *
 * 约定：handler 内部一切抛错自己转成 HTTP 状态码，绝不让 promise reject 出去——
 * 宿主只 try/catch 同步抛错，异步 rejection 会变成 unhandledRejection 把整个
 * 服务打挂（image-toolkit 踩过的坑）。
 */

import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REMOTE_TRANSCRIBE_TIMEOUT_MS = 120_000;
/** 远端 Whisper 单文件上限 25MB；超了直接 413，不浪费一次转发。 */
const MAX_REMOTE_AUDIO_BYTES = 25 * 1024 * 1024;
/** 本地 WAV 上限 15MB（16k 单声道 ≈ 8 分钟，足够口述）。 */
const MAX_LOCAL_AUDIO_BYTES = 15 * 1024 * 1024;
/** transformers.js 运行时（ONNX 预编译，win/mac/linux 全平台，CPU 可跑）。 */
const TRANSFORMERS_PKG = "@xenova/transformers";
const TRANSFORMERS_SPEC = `${TRANSFORMERS_PKG}@2.17.2`;

/**
 * 本地模型档位 → HuggingFace 模型 id。白名单：install 接口只认这俩，
 * 杜绝「用户可控 URL 任意下载」的口子。
 */
export const LOCAL_MODELS = {
	tiny: "Xenova/whisper-tiny", // ~150MB，中英短句够用，老机器首选
	base: "Xenova/whisper-base", // ~290MB，中文长句明显更准（默认）
	small: "Xenova/whisper-small", // ~500MB，2.4 亿参数，中文同音字少很多；CPU 转写比 base 慢 3~4 倍
};

/** 档位名 → 模型 id，非法输入回 null。纯函数，单测覆盖。 */
export function resolveLocalModel(size) {
	const s = typeof size === "string" ? size.trim().toLowerCase() : "";
	return Object.prototype.hasOwnProperty.call(LOCAL_MODELS, s) ? LOCAL_MODELS[s] : null;
}

function str(v) {
	return typeof v === "string" ? v.trim() : "";
}

/**
 * 插件语言（zh-CN / en-US …）→ 远端 Whisper 的 language 参数（ISO-639-1）。
 * 纯函数，单测覆盖。
 */
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

/**
 * 插件语言 → 本地 transformers.js Whisper 的 language 参数（英文全名）。
 * 纯函数，单测覆盖。
 */
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

/** 基址 + 路径拼接（容忍末尾斜杠）。纯函数，单测覆盖。 */
export function joinUrl(base, path) {
	return `${str(base).replace(/\/+$/, "")}${path}`;
}

/**
 * package.json → 入口文件候选（相对路径，按优先级）。纯函数，单测覆盖。
 *
 * 不能只信 `exports`：`exports["."]` 可能是字符串，也可能是带条件
 * （import / require / default / node / browser…）的对象，形状没对齐就取空。
 * 这里把常见形状摊平，再兜几个 transformers.js 的历史布局名。
 */
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

/** 权重下载源：设置里的 hfEndpoint > 环境变量 HF_ENDPOINT > 官方（空 = 不改）。
 *  国内直连 huggingface.co 常超时，hf-mirror.com 是社区镜像。非 http(s) 一律忽略。 */
export function hfEndpointHost(setting, env = process.env.HF_ENDPOINT) {
	const s = str(setting || env).replace(/\/+$/, "");
	return /^https?:\/\/\S+$/i.test(s) ? s : "";
}

/* ------------------------------------------------------------------ */
/* WAV 解码：客户端发的 16k 单声道 16-bit WAV 转 Float32Array（本地      */
/* Whisper 的输入）。兼容其它采样率/声道/位深（线性重采样 + 声道平均）， */
/* 保证手写编码器的小偏差不炸。纯函数，单测覆盖。                        */
/* ------------------------------------------------------------------ */

/** 线性重采样。纯函数，单测覆盖。 */
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

/**
 * WAV（PCM/Float）→ 16kHz 单声道 Float32Array。
 * 抛错信息直接面向用户（中文）。纯函数，单测覆盖。
 */
export function decodeWav16k(buf) {
	const u8 = Buffer.isBuffer(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
	if (!(u8 instanceof Uint8Array) || u8.length < 44) throw new Error("音频不是有效的 WAV（太短）");
	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
		throw new Error("音频不是有效的 WAV（缺 RIFF/WAVE 头）");
	}
	// 遍历 chunk：fmt 拿格式，data 拿采样（跳过 fact/LIST 等）。
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
			// 设置里改「给 AI 转写工具」要即时生效（注册/下架），不用重启服务。
			syncTranscribeTool();
		});

		/** 本地引擎运行态（常驻内存，重启服务清零；安装标记在 storage 里持久化）。 */
		const local = {
			installing: false,
			progress: null, // 0~100，null=未知/非下载阶段
			phase: "",
			error: "",
			pipe: null, // transformers pipeline（热缓存）
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
		const localReady = () => Boolean(installedModels()[wantedModelId()]);

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
					// 体超限（413）：响应已写回，再销毁读端停止继续上传
					if (status === 413) req.destroy();
				}
			});

		/** 读原始请求体（JSON 小包或二进制大包，抄 image-toolkit 的 readBody）。
		 *  收包循环内实时累计，超过远端转写上限立即停收并 413，不全量缓存完再查。 */
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
						req.pause(); // 停收（不销毁）：让 413 先送出去，safe() 再掐断
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

		/* ---------------- 本地引擎：装 / 状态 / 卸 ---------------- */

		/**
		 * transformers.js 入口文件：先按 package.json 拼绝对路径，绕开 CJS 解析缓存。
		 *
		 * `createRequire().resolve()` 走 Node 的进程级解析，package.json 路径缓存会把
		 * 「文件不存在」记成**负结果**且不随 npm install 失效（issue #383：明明装成功
		 * 却恒报「运行时装不上」，只能重启服务）。盘上判据不受影响，所以先读
		 * package.json 自己定位入口；读不到（exports 怪形状 / 文件损坏）再回落老路。
		 */
		function transformersEntry() {
			const pkgDir = join(dir, "node_modules", ...TRANSFORMERS_PKG.split("/"));
			try {
				const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
				for (const rel of pkgEntryCandidates(pkg)) {
					const abs = join(pkgDir, rel);
					if (existsSync(abs)) return abs;
				}
			} catch {
				/* package.json 读不到 / 坏了：走下面的 resolve 回落 */
			}
			return createRequire(join(dir, "index.mjs")).resolve(TRANSFORMERS_PKG);
		}

		async function importTransformers() {
			const ok = await host.ensureDeps?.([TRANSFORMERS_SPEC], {
				onProgress: (m) => {
					local.phase = str(m) || "正在安装本地语音运行时…";
				},
			});
			if (!ok) throw new Error("本地语音运行时安装失败（npm install 没跑通，请检查网络后重试）");
			// ESM 不支持目录 import（ERR_UNSUPPORTED_DIR_IMPORT），且 import() 也要一个
			// 真实文件路径 —— 所以先定位入口文件，再按 file URL import（URL 恒可 import）。
			let entry;
			try {
				entry = transformersEntry();
			} catch {
				throw new Error("本地语音运行时装上了但解析不到入口（node_modules 可能损坏，删了重装）");
			}
			const mod = await import(pathToFileURL(entry).href);
			if (!mod || !mod.pipeline) throw new Error("本地语音运行时加载失败（依赖装上了但 import 不到）");
			mod.env.cacheDir = cacheDir;
			// 权重下载源：transformers.js v2 只认自己的 env.remoteHost，不读 HF_ENDPOINT
			// （v3 才读），所以手工接上，否则国内直连 huggingface.co 会卡到超时。
			const endpoint = hfEndpointHost(cfg.hfEndpoint);
			if (endpoint && mod.env) {
				mod.env.remoteHost = endpoint;
				mod.env.remotePathTemplate = `${endpoint}/{model}/resolve/{revision}/`;
			}
			return mod;
		}

		/** 后台安装全流程（单飞）：运行时 → 权重下载 → 预热。进度写 local.*。 */
		async function runInstall(modelId) {
			local.installing = true;
			local.progress = null;
			local.error = "";
			try {
				local.phase = "正在安装本地语音运行时（首次约几分钟）…";
				const tf = await importTransformers();
				local.phase = `正在下载语音模型（${modelId}，首次约几百 MB）…`;
				const seen = new Map(); // file → { loaded, total }
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
						} catch {
							/* 进度上报失败不影响安装 */
						}
					},
				});
				if (!pipe) throw new Error("语音模型加载返回空");
				local.phase = "预热…";
				// 3 秒静音过一遍：把 onnx session 真正跑起来，首句转写不冷启动。
				try {
					await pipe(new Float32Array(16000 * 3), { language: "english", task: "transcribe" });
				} catch {
					/* 预热失败不致命 */
				}
				try {
					if (local.pipe && local.loadedModel !== modelId) {
						await local.pipe.model?.dispose?.();
					}
				} catch {
					/* ignore */
				}
				local.pipe = pipe;
				local.loadedModel = modelId;
				const prev = installedModels();
				prev[modelId] = true;
				try {
					host.storage.set("whisperModels", prev);
				} catch {
					/* 标记写失败：下次重启会重新下载，不致命 */
				}
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

		/** 拿热 pipeline（内存里没有就懒加载；权重缺了会自动重下，自愈）。 */
		async function getPipe(modelId) {
			if (local.pipe && local.loadedModel === modelId) return local.pipe;
			const tf = await importTransformers();
			try {
				if (local.pipe) {
					await local.pipe.model?.dispose?.();
				}
			} catch {
				/* ignore */
			}
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
			// 8 分钟硬截：防超长音频把 CPU 跑死。
			const capped = samples.length > 16000 * 480 ? samples.slice(0, 16000 * 480) : samples;
			const pipe = await getPipe(modelId);
			const fullLang = whisperFullLang(lang);
			const out = await pipe(capped, {
				language: fullLang || undefined,
				task: "transcribe",
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

		/* ---------------- 远端引擎（OpenAI 兼容） ---------------- */

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

		/* ---------------- 路由 ---------------- */

		/** 客户端读公开配置（密钥永不下发）。 */
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

		/**
		 * 客户端改「转写引擎」（麦克风浮层里的切换面板，issue #383）。
		 *
		 * 直写声明式设置（storage.json 的 settings 键）—— 与宿主设置面板的
		 * saveSettingsValues 同一个键，host.storage.set 内部已用同一把文件级 RMW 锁
		 * 且写前重读，两边交替保存不会互相抹掉。
		 *
		 * 刻意只 RMW `engine` 这一个键、而不是把 getSettings() 的合并值整份写回：
		 * 整份写回会把「用户从没设过」的字段固化成当前默认值，以后改 schema 默认值
		 * 对老用户就不生效了。值只认白名单三档。
		 */
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
			// 内存里的快照同步跟上（本进程后续的 host.getSettings() 也会从磁盘读到新值）。
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
			} catch {
				/* ignore */
			}
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
			} catch {
				/* ignore */
			}
			local.progress = null;
			local.phase = "";
			local.error = "";
			res.json({ ok: true, freed });
		});

		/**
		 * 音频 → { text, engine }：本地/远端/auto 三档分发。
		 *
		 * HTTP 路由（浏览器录音）与 transcribe_audio 工具（工作区音频文件）**共用这一份**：
		 * 「什么时候悄悄降级、什么时候把错误抛给调用方」两处各写一套必然漂移。
		 * 抛错一律带 statusCode（沿用既有口径）—— 路由把它翻成 HTTP 码，工具把它翻成人话。
		 *
		 * 注意：本地引擎只吃 WAV 字节（没有 ffmpeg 解码器），非 WAV 必须由调用方自己走 transcribeRemote。
		 */
		async function runTranscribe(audio, mime, lang) {
			const eng = engine();
			const tryLocal = eng !== "remote" && localReady();
			const tryRemote = eng !== "local" && remoteReady();

			const fail = (msg, code) => {
				const e = new Error(msg);
				e.statusCode = code;
				return e;
			};

			// auto：本地优先（免费不出网），本地炸了再试远端；local：只用本地。
			if (eng !== "remote" && tryLocal) {
				if (audio.length > MAX_LOCAL_AUDIO_BYTES) throw fail("音频太长（>8分钟），请分段", 413);
				if (local.transcribeBusy) throw fail("本地正在转写上一段，稍等几秒再试", 429);
				local.transcribeBusy = true;
				try {
					return { text: await transcribeLocal(audio, lang), engine: "local" };
				} catch (err) {
					// 本地挂了且有远端可兜：悄悄降级（415 非 WAV / 400 太短 之类调用方问题除外，那类换谁也一样）。
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

		/** 录音 → 本地/远端 → { text, engine }。 */
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

		/* ------------------------------------------------------------------ */
		/* AI 工具：把工作区里的音频文件转成文字（transcribe_audio）            */
		/* ------------------------------------------------------------------ */

		/** 扩展名 → MIME。远端接口按 MIME 决定上传文件名后缀；本地引擎不看 MIME（只认 WAV 字节）。 */
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

		/** 头 12 字节判 WAV（RIFF....WAVE）——扩展名会骗人，字节不会。 */
		function looksLikeWav(buf) {
			try {
				const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
				return b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE";
			} catch {
				return false;
			}
		}

		let offTranscribeTool = null;

		/** 按设置注册/下架 transcribe_audio（保存设置即时生效，与 image-toolkit 同做法）。 */
		function syncTranscribeTool() {
			const want = cfg.transcribeTool !== false;
			if (want && !offTranscribeTool) {
				offTranscribeTool = host.registerAgentTool({
					name: "transcribe_audio",
					label: "转写音频文件",
					description:
						"Transcribe an audio file that lives in the workspace (a meeting recording, a voice memo, the audio track of a video) into text, so you can read what was said — you cannot listen to audio yourself. " +
						"WAV works with the free offline local Whisper; other formats (mp3/m4a/ogg/webm) need the remote endpoint configured in this plugin's settings, because the local engine has no decoder for them. " +
						"Local transcription is capped at ~8 minutes per call — for longer recordings, split them first. " +
						"Returns the transcript plus which engine produced it. Only files inside the workspace can be read.",
					promptSnippet:
						"transcribe a workspace audio file to text (WAV offline via local Whisper; other formats need the plugin's remote endpoint)",
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
						// 本地引擎只吃 WAV：非 WAV 又没配远端 → 直接把两条出路讲清楚，别抛一个模型看不懂的 415。
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
							// 非 WAV 直接走远端：自动档在本地优先时一定会撞上「本地只要 WAV」，没必要让它白撞一次。
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
				} catch {
					/* ignore */
				}
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
			} catch {
				/* ignore */
			}
			for (const off of [offGet, offStatus, offEngine, offInstall, offUninstall, offPost]) {
				try {
					off();
				} catch {
					/* ignore */
				}
			}
			try {
				offSettings?.();
			} catch {
				/* ignore */
			}
			host.log("voice-input deactivated");
		};
	},
};
