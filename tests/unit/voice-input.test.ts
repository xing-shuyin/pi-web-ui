import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUiContributions } from "../../server/plugins.js";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import voiceInput, {
	applyHfEndpoint,
	decodeWav16k,
	DEFAULT_INITIAL_PROMPTS,
	ensureSharpStub,
	hasCachedModelOnDisk,
	hfEndpointHost,
	joinUrl,
	LOCAL_MODELS,
	pkgEntryCandidates,
	resampleLinear,
	resolveInitialPrompt,
	resolveLocalModel,
	whisperFullLang,
	whisperLang,
} from "../../plugins/voice-input/index.mjs";
import {
	audioLevelFromRms,
	computeAudioRms,
	encodeWavPCM,
	engineBadgeText,
	pickEngineRoute,
	resolveActiveEngine,
	srExplain,
	srTotalText,
} from "../../plugins/voice-input/client/entry.mjs";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "voice-input");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));

describe("voice-input manifest", () => {
	it("无独立视图 + 严格模式能力声明齐全", () => {
		expect(manifest.id).toBe("voice-input");
		expect(manifest.view).toBe(false);
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.permissions).toContain("ui");
		expect(manifest.permissions).toContain("http");
		expect(manifest.permissions).toContain("fs:read");
		expect(manifest.permissions).toContain("tools");
	});

	it("ui 贡献解析出麦克风与摄像头两条输入框动作", () => {
		const parsed = parseUiContributions(manifest.ui);
		expect(parsed?.items).toHaveLength(2);
		const mic = parsed!.items.find((i) => i.action === "voice-input:toggle")!;
		expect(mic.slot).toBe("composer.actions");
		expect(mic.kind).toBe("action");
		expect(mic.id).toBe("mic");
		expect(mic.label).toBeTruthy();
		expect(mic.labelEn).toBeTruthy();
		const cam = parsed!.items.find((i) => i.action === "voice-input:camera")!;
		expect(cam.slot).toBe("composer.actions");
		expect(cam.kind).toBe("action");
		expect(cam.id).toBe("camera");
		expect(cam.label).toBeTruthy();
		expect(cam.labelEn).toBeTruthy();
		expect([mic.icon, cam.icon].sort()).toEqual(["camera", "mic"]);
	});

	it("settings 有语言/降级开关/转写三件套且默认值对", () => {
		const byKey = Object.fromEntries(manifest.settings.map((f: { key: string }) => [f.key, f]));
		expect(byKey.lang.default).toBe("zh-CN");
		expect(byKey.serverFallback.default).toBe(true);
		expect(byKey.transcribeUrl.default).toBe("");
		expect(byKey.transcribeKey.type).toBe("password");
		expect(byKey.transcribeModel.default).toBe("whisper-1");
		expect(byKey.transcribeTool.type).toBe("boolean");
		expect(byKey.transcribeTool.default).toBe(true);
	});

	it("settings 有引擎/本地模型两档且默认值对", () => {
		const byKey = Object.fromEntries(manifest.settings.map((f: { key: string }) => [f.key, f]));
		expect(byKey.engine.type).toBe("select");
		expect(byKey.engine.default).toBe("auto");
		expect(byKey.engine.options).toEqual(expect.arrayContaining(["auto", "local", "remote"]));
		expect(byKey.localModel.type).toBe("select");
		expect(byKey.localModel.default).toBe("base");
		expect(byKey.localModel.options).toEqual(expect.arrayContaining(["base", "tiny"]));
		expect(byKey.hfEndpoint.type).toBe("text");
		expect(byKey.hfEndpoint.default).toBe("");
	});
});

describe("pickEngineRoute", () => {
	it("local：已装直接录服务端，没装直接给安装入口（不等联网失败）", () => {
		expect(pickEngineRoute("local", { localReady: true, serverReady: false, srSupported: true })).toBe("rec");
		expect(pickEngineRoute("local", { localReady: false, serverReady: true, srSupported: true })).toBe("install-local");
	});
	it("remote：已配直接录，没配指向设置", () => {
		expect(pickEngineRoute("remote", { serverReady: true, localReady: false })).toBe("rec");
		expect(pickEngineRoute("remote", { serverReady: false, localReady: true })).toBe("remote-missing");
	});
	it("显式选引擎时「服务端转写降级」开关不拦（它是给 auto 兜底用的）", () => {
		expect(pickEngineRoute("local", { localReady: true, serverFallback: false })).toBe("rec");
		expect(pickEngineRoute("remote", { serverReady: true, serverFallback: false })).toBe("rec");
	});
	it("auto：浏览器原生优先，没有则降级服务端，两边都没得用才引导安装", () => {
		expect(pickEngineRoute("auto", { srSupported: true, localReady: false, serverReady: false })).toBe("sr");
		expect(pickEngineRoute("auto", { srSupported: false, localReady: true, serverFallback: true })).toBe("rec");
		expect(pickEngineRoute("auto", { srSupported: false, localReady: false, serverReady: true })).toBe("rec");
		expect(pickEngineRoute("auto", { srSupported: false, localReady: false, serverReady: false })).toBe(
			"install-generic",
		);
		expect(pickEngineRoute("auto", { srSupported: false, localReady: true, serverFallback: false })).toBe(
			"fallback-off",
		);
	});
	it("非法/缺省引擎回落 auto", () => {
		expect(pickEngineRoute(undefined, { srSupported: true })).toBe("sr");
		expect(pickEngineRoute("LOCAL", { localReady: true })).toBe("rec");
		expect(pickEngineRoute("", { srSupported: false })).toBe("install-generic");
	});
	it("toggle 不再自己判浏览器能力（分流只有 startByEngine 一处）", () => {
		const src = readFileSync(join(pluginDir, "client", "entry.mjs"), "utf8");
		const toggle = src.slice(
			src.indexOf("async function toggle()"),
			src.indexOf("const CAMERA_ACTION =", src.indexOf("async function toggle()")),
		);
		expect(toggle).toContain("startByEngine(cfg)");
		expect(toggle).not.toContain("srSupported()");
	});
});

describe("pkgEntryCandidates", () => {
	it("exports 带条件时按 import/module/default/require 排优先级", () => {
		expect(
			pkgEntryCandidates({
				exports: { ".": { require: "./dist/transformers.cjs", import: "./dist/transformers.mjs" } },
			}),
		).toEqual([
			"./dist/transformers.mjs",
			"./dist/transformers.cjs",
			"dist/transformers.js",
			"dist/transformers.mjs",
			"dist/transformers.cjs",
		]);
	});
	it("exports 是字符串 / 只有 module / 只有 main 都认", () => {
		expect(pkgEntryCandidates({ exports: { ".": "./dist/transformers.js" } })[0]).toBe("./dist/transformers.js");
		expect(pkgEntryCandidates({ module: "esm.js", main: "cjs.js" }).slice(0, 2)).toEqual(["esm.js", "cjs.js"]);
	});
	it("没有可用字段也兜一个历史布局名，不返回空", () => {
		expect(pkgEntryCandidates({})).toContain("dist/transformers.js");
		expect(pkgEntryCandidates(null)).toContain("dist/transformers.js");
	});
});

describe("hfEndpointHost", () => {
	it("设置优先于环境变量，末尾斜杠归一", () => {
		expect(hfEndpointHost("https://hf-mirror.com/", "https://huggingface.co")).toBe("https://hf-mirror.com");
		expect(hfEndpointHost("", "https://hf-mirror.com")).toBe("https://hf-mirror.com");
	});
	it("非 http(s) / 空 → 空（不改官方源）", () => {
		expect(hfEndpointHost("", "")).toBe("");
		expect(hfEndpointHost(undefined, "")).toBe("");
		expect(hfEndpointHost("file:///etc/passwd", "")).toBe("");
		expect(hfEndpointHost("ftp://x.example", "")).toBe("");
	});
});

describe("applyHfEndpoint", () => {
	it("只改 remoteHost，不动 remotePathTemplate（模板带主机名会被 v2 拼成双重前缀）", () => {
		const env = { remoteHost: "https://huggingface.co/", remotePathTemplate: "{model}/resolve/{revision}/" };
		applyHfEndpoint(env, "https://hf-mirror.com");
		expect(env.remoteHost).toBe("https://hf-mirror.com");
		expect(env.remotePathTemplate).toBe("{model}/resolve/{revision}/");
	});
	it("endpoint 为空或 env 缺失时保持原值", () => {
		const env = { remoteHost: "https://huggingface.co/", remotePathTemplate: "{model}/resolve/{revision}/" };
		applyHfEndpoint(env, "");
		expect(env.remoteHost).toBe("https://huggingface.co/");
		expect(applyHfEndpoint(undefined, "https://hf-mirror.com")).toBeUndefined();
	});
});

describe("whisperLang", () => {
	it.each([
		["zh-CN", "zh"],
		["zh-TW", "zh"],
		["en-US", "en"],
		["en-GB", "en"],
		["ja-JP", "ja"],
		["", ""],
		["xx-YY", ""],
	])("%s → %s", (input, expected) => {
		expect(whisperLang(input)).toBe(expected);
	});
});

describe("whisperFullLang", () => {
	it.each([
		["zh-CN", "chinese"],
		["zh-TW", "chinese"],
		["en-US", "english"],
		["ja-JP", "japanese"],
		["ko-KR", "korean"],
		["fr-FR", "french"],
		["de-DE", "german"],
		["es-ES", "spanish"],
		["ru-RU", "russian"],
		["it-IT", "italian"],
		["pt-BR", "portuguese"],
		["", ""],
		["xx-YY", ""],
	])("%s → %s", (input, expected) => {
		expect(whisperFullLang(input)).toBe(expected);
	});
});

describe("resolveLocalModel", () => {
	it("白名单内三档", () => {
		expect(resolveLocalModel("tiny")).toBe("Xenova/whisper-tiny");
		expect(resolveLocalModel("base")).toBe("Xenova/whisper-base");
		expect(resolveLocalModel("small")).toBe("Xenova/whisper-small");
		expect(resolveLocalModel(" Base ")).toBe("Xenova/whisper-base");
	});
	it("白名单外一律 null（防任意模型 id 注入下载）", () => {
		expect(resolveLocalModel("openai/whisper-large-v3")).toBeNull();
		expect(resolveLocalModel("https://evil.example/m.bin")).toBeNull();
		expect(resolveLocalModel("")).toBeNull();
		expect(resolveLocalModel(null)).toBeNull();
		expect(resolveLocalModel(undefined)).toBeNull();
	});
});

describe("resolveInitialPrompt", () => {
	it("用户自定义 prompt 优先", () => {
		expect(resolveInitialPrompt("zh-CN", { initialPrompt: "自定义术语" })).toBe("自定义术语");
	});
	it("中文默认简体", () => {
		expect(resolveInitialPrompt("zh-CN")).toBe(DEFAULT_INITIAL_PROMPTS.zh);
		expect(resolveInitialPrompt("zh-Hans", { zhVariant: "simplified" })).toBe(DEFAULT_INITIAL_PROMPTS.zh);
	});
	it("中文繁体模式匹配繁体提示词", () => {
		expect(resolveInitialPrompt("zh-CN", { zhVariant: "traditional" })).toBe(DEFAULT_INITIAL_PROMPTS["zh-traditional"]);
	});
	it("英文匹配英文提示词", () => {
		expect(resolveInitialPrompt("en-US")).toBe(DEFAULT_INITIAL_PROMPTS.en);
	});
});

describe("resampleLinear", () => {
	it("同采样率原样返回", () => {
		const src = new Float32Array([0.1, 0.2, 0.3]);
		const out = resampleLinear(src, 16000, 16000);
		expect(out.length).toBe(3);
		for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(src[i]!, 6);
		expect(out).not.toBe(src);
	});
	it("48k→16k 长度约 1/3 且端点对齐", () => {
		const src = new Float32Array(480);
		for (let i = 0; i < src.length; i++) src[i] = i / 479;
		const out = resampleLinear(src, 48000, 16000);
		expect(out.length).toBe(160);
		expect(out[0]).toBeCloseTo(0, 5);
		expect(out[159]).toBeCloseTo(1, 2);
	});
	it("空输入回空", () => {
		expect(resampleLinear(new Float32Array(0), 48000, 16000).length).toBe(0);
	});
	it("非法采样率抛错", () => {
		expect(() => resampleLinear(new Float32Array([1]), 0, 16000)).toThrow();
	});
});

describe("decodeWav16k", () => {
	function buildWav(frames: number[][], sampleRate: number) {
		const channels = frames.length;
		const n = frames[0]!.length;
		const dataLen = n * channels * 2;
		const junk = 8;
		const buf = new ArrayBuffer(12 + 8 + 16 + 8 + junk + 8 + dataLen);
		const v = new DataView(buf);
		const wstr = (o: number, s: string) => {
			for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
		};
		wstr(0, "RIFF");
		v.setUint32(4, buf.byteLength - 8, true);
		wstr(8, "WAVE");
		wstr(12, "JUNK");
		v.setUint32(16, junk, true);
		const fmtOff = 12 + 8 + junk;
		wstr(fmtOff, "fmt ");
		v.setUint32(fmtOff + 4, 16, true);
		v.setUint16(fmtOff + 8, 1, true);
		v.setUint16(fmtOff + 10, channels, true);
		v.setUint32(fmtOff + 12, sampleRate, true);
		v.setUint32(fmtOff + 16, sampleRate * channels * 2, true);
		v.setUint16(fmtOff + 20, channels * 2, true);
		v.setUint16(fmtOff + 22, 16, true);
		const dataOff = fmtOff + 8 + 16;
		wstr(dataOff, "data");
		v.setUint32(dataOff + 4, dataLen, true);
		let p = dataOff + 8;
		for (let i = 0; i < n; i++) {
			for (let c = 0; c < channels; c++) {
				const s = Math.max(-1, Math.min(1, frames[c]![i]!));
				v.setInt16(p, Math.round(s * 32767), true);
				p += 2;
			}
		}
		return Buffer.from(buf);
	}

	it("16k 单声道直解", () => {
		const out = decodeWav16k(buildWav([[0, 0.5, -0.5, 1]], 16000));
		expect(out.length).toBe(4);
		expect(out[1]).toBeCloseTo(0.5, 3);
		expect(out[2]).toBeCloseTo(-0.5, 3);
	});

	it("48k 立体声 → 16k 单声道（平均+重采样）", () => {
		const frames: number[][] = [[], []];
		for (let i = 0; i < 480; i++) {
			frames[0]!.push(i / 479);
			frames[1]!.push(i / 479);
		}
		const out = decodeWav16k(buildWav(frames, 48000));
		expect(out.length).toBe(160);
		expect(out[0]).toBeCloseTo(0, 3);
		expect(out[159]).toBeCloseTo(1, 2);
	});

	it("客户端 encodeWavPCM → 服务端 decodeWav16k 往返", () => {
		const src = new Float32Array(1600);
		for (let i = 0; i < src.length; i++) src[i] = Math.sin((i / 1600) * Math.PI * 4) * 0.5;
		const wav = Buffer.from(encodeWavPCM(src, 16000));
		const out = decodeWav16k(wav);
		expect(out.length).toBe(src.length);
		for (let i = 0; i < src.length; i += 100) expect(out[i]).toBeCloseTo(src[i]!, 2);
	});

	it("坏输入抛中文错", () => {
		expect(() => decodeWav16k(Buffer.alloc(10))).toThrow("WAV");
		const bad = Buffer.from(encodeWavPCM(new Float32Array([0.1]), 16000));
		bad.write("XXXX", 0);
		expect(() => decodeWav16k(bad)).toThrow("RIFF");
	});
});

describe("srExplain", () => {
	it("Edge 常见错误码都有中文解释", () => {
		expect(srExplain("not-allowed").kind).toBe("denied");
		expect(srExplain("service-not-allowed").kind).toBe("denied");
		expect(srExplain("network").kind).toBe("network");
		expect(srExplain("no-speech").kind).toBe("nospeech");
		expect(srExplain("audio-capture").kind).toBe("nospeech");
		for (const code of ["not-allowed", "network", "no-speech", "audio-capture", "oops"]) {
			const m = srExplain(code);
			expect(typeof m.msg).toBe("string");
			expect(m.msg.length).toBeGreaterThan(4);
		}
	});
});

describe("srTotalText", () => {
	it("最终文本 + 中间结果拼成全文并去首尾空白", () => {
		expect(srTotalText("你好", "世界")).toBe("你好世界");
		expect(srTotalText("你好 ", "")).toBe("你好");
		expect(srTotalText("", "  ")).toBe("");
		expect(srTotalText(null, undefined)).toBe("");
	});
	it("直接发送走当前对话：entry 调用 startChat 时 newChat:false", () => {
		const src = readFileSync(join(pluginDir, "client", "entry.mjs"), "utf8");
		expect(src).toContain("newChat: false");
		expect(src).toContain("startChat");
	});
	it("本地引擎录音中主按钮文案为「停止并转写」，避免与浏览器即时识别的「填入输入框」语义歧义 (issue #549)", () => {
		const src = readFileSync(join(pluginDir, "client", "entry.mjs"), "utf8");
		expect(src).toContain('stopAndTranscribe: isZh ? "停止并转写" : "Stop & transcribe"');
		expect(src).toContain("label: T.stopAndTranscribe");
	});
});

describe("resolveActiveEngine & engineBadgeText (issue #548)", () => {
	it("resolveActiveEngine: sr 模式下返回 sr", () => {
		expect(resolveActiveEngine({ engine: "auto" }, "sr")).toBe("sr");
		expect(resolveActiveEngine({ engine: "local" }, "sr")).toBe("sr");
	});

	it("resolveActiveEngine: rec 模式下根据显式配置与就绪状态解析", () => {
		expect(resolveActiveEngine({ engine: "remote" }, "rec")).toBe("remote");
		expect(resolveActiveEngine({ engine: "local" }, "rec")).toBe("local");
		expect(resolveActiveEngine({ engine: "auto", localReady: true }, "rec")).toBe("local");
		expect(resolveActiveEngine({ engine: "auto", localReady: false, serverReady: true }, "rec")).toBe("remote");
	});

	it("engineBadgeText: 中英文与模型名正确格式化", () => {
		expect(engineBadgeText("sr", { isZh: true })).toBe("🌐 浏览器识别");
		expect(engineBadgeText("sr", { isZh: false })).toBe("🌐 Browser speech");
		expect(engineBadgeText("remote", { isZh: true })).toBe("☁️ 远端接口");
		expect(engineBadgeText("remote", { isZh: false })).toBe("☁️ Remote endpoint");
		expect(engineBadgeText("local", { isZh: true, localModel: "base" })).toBe("🧠 本地 Whisper(base)");
		expect(engineBadgeText("local", { isZh: false, localModel: "tiny" })).toBe("🧠 Local Whisper (tiny)");
	});
});

describe("录音电平计算 (issue #550)", () => {
	it("computeAudioRms: 空数组/无效输入返回 0", () => {
		expect(computeAudioRms(null as unknown as Float32Array)).toBe(0);
		expect(computeAudioRms([] as unknown as Float32Array)).toBe(0);
		expect(computeAudioRms(new Float32Array(0))).toBe(0);
	});

	it("computeAudioRms: 全 0 静音返回 0", () => {
		const silent = new Float32Array(128);
		expect(computeAudioRms(silent)).toBe(0);
		expect(audioLevelFromRms(0)).toBe(0);
	});

	it("computeAudioRms & audioLevelFromRms: 正常振幅计算并平滑映射", () => {
		const frames = new Float32Array([0.1, -0.1, 0.1, -0.1]);
		const rms = computeAudioRms(frames);
		expect(rms).toBeCloseTo(0.1, 5);
		const level = audioLevelFromRms(rms);
		expect(level).toBe(0.45);
	});

	it("audioLevelFromRms: 大振幅封顶为 1，负数/非法值保护返回 0", () => {
		expect(audioLevelFromRms(1.0)).toBe(1);
		expect(audioLevelFromRms(-1)).toBe(0);
		expect(audioLevelFromRms(NaN)).toBe(0);
	});
});

describe("引擎切换路由（POST /engine）", () => {
	function route(
		host: { mock: { routes: { method: string; path: string; handler: (req: unknown, res: unknown) => unknown }[] } },
		method: string,
		path: string,
	) {
		const r = host.mock.routes.find((x) => x.method === method && x.path === path);
		if (!r) throw new Error(`没注册路由：${method} ${path}`);
		return r.handler;
	}
	function fakeRes() {
		return {
			statusCode: 200,
			headersSent: false,
			body: null as unknown,
			status(code: number) {
				this.statusCode = code;
				return this;
			},
			json(payload: unknown) {
				this.body = payload;
				return this;
			},
			end() {
				return this;
			},
		};
	}

	it("合法值写回声明式设置，并只动 engine 这一个键", async () => {
		const { host } = boot({ engine: "auto" });
		host.storage.set("settings", { lang: "en-US" });
		const res = fakeRes();
		await route(host, "POST", "/engine")({ body: { engine: "local" } }, res);
		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ ok: true, engine: "local" });
		expect(host.storage.get("settings")).toEqual({ lang: "en-US", engine: "local" });
	});

	it("大小写/空白归一，非法值 400 且不写盘", async () => {
		const { host } = boot();
		const ok = fakeRes();
		await route(host, "POST", "/engine")({ body: { engine: " Local " } }, ok);
		expect(ok.body).toMatchObject({ engine: "local" });

		const bad = fakeRes();
		await route(host, "POST", "/engine")({ body: { engine: "evil" } }, bad);
		expect(bad.statusCode).toBe(400);
		expect(host.storage.get("settings")).toEqual({ engine: "local" });

		const empty = fakeRes();
		await route(host, "POST", "/engine")({}, empty);
		expect(empty.statusCode).toBe(400);
	});
});

describe("joinUrl", () => {
	it("容忍基址末尾斜杠", () => {
		expect(joinUrl("https://api.openai.com/v1/", "/audio/transcriptions")).toBe(
			"https://api.openai.com/v1/audio/transcriptions",
		);
		expect(joinUrl("https://api.openai.com/v1", "/audio/transcriptions")).toBe(
			"https://api.openai.com/v1/audio/transcriptions",
		);
	});
});

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	vi.restoreAllMocks();
});

const makeWav = (samples = 16000) => encodeWavPCM(new Float32Array(samples), 16000);

function boot(settings: Record<string, unknown> = {}, files: Record<string, Uint8Array> = {}) {
	const host = createMockHost({
		settings,
		fs: {
			read: async (p: string) => {
				const f = files[String(p)];
				if (!f) throw new Error(`ENOENT: no such file or directory '${p}'`);
				return f;
			},
			readPath: async (p: string) => {
				const f = files[String(p)];
				if (!f) throw new Error(`未授权目录 '${p}'`);
				return f;
			},
		},
	});
	const off = voiceInput.activate(host);
	cleanups.push(() => off());
	const tool = () => host.mock.agentTools.find((t: { name: string }) => t.name === "transcribe_audio");
	return { host, tool };
}

const REMOTE_CFG = { transcribeUrl: "https://example.test/v1", transcribeKey: "sk-test", engine: "remote" };

function stubRemote(text = "会议纪要内容") {
	const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ text }) }));
	vi.stubGlobal("fetch", fetchSpy);
	return fetchSpy;
}

describe("transcribe_audio 注册与下架", () => {
	it("activate 后注册了工具，描述里说清「我听不了音频」且必填 path", () => {
		const { tool } = boot();
		const t = tool();
		expect(t).toBeTruthy();
		expect(t.description).toContain("workspace");
		expect(t.description).toContain("cannot listen");
		expect(t.parameters.required).toEqual(["path"]);
		expect(t.parameters.properties.path.type).toBe("string");
		expect(t.parameters.properties.lang.type).toBe("string");
	});

	it("设置里关掉即下架，打开即回来（不用重启服务）", () => {
		const { host, tool } = boot();
		expect(tool()).toBeTruthy();
		host.mock.emitSettings({ transcribeTool: false });
		expect(tool()).toBeUndefined();
		host.mock.emitSettings({ transcribeTool: true });
		expect(tool()).toBeTruthy();
		host.mock.emitSettings({ transcribeTool: true });
		expect(host.mock.agentTools.filter((t: { name: string }) => t.name === "transcribe_audio")).toHaveLength(1);
	});

	it("设置里一开始就是关的 → 不注册", () => {
		const { tool } = boot({ transcribeTool: false });
		expect(tool()).toBeUndefined();
	});
});

describe("transcribe_audio 执行路径", () => {
	it("缺 path → 明确报错，不抛异常", async () => {
		const { tool } = boot();
		expect(String(await tool().execute("id", {}))).toContain("path");
	});

	it("读不到文件 → 报路径 + 工作区外要先加工作区根", async () => {
		const { tool } = boot();
		const out = String(await tool().execute("id", { path: "nope.wav" }));
		expect(out).toContain("nope.wav");
		expect(out).toContain("工作区");
	});

	it("绝对路径走 host.fs.readPath（能报出未授权原因）", async () => {
		const { host, tool } = boot();
		const out = String(await tool().execute("id", { path: "E:\\audio\\meeting.wav" }));
		expect(out).toContain("读不到");
		expect(host.mock.calls("fs.readPath")).toHaveLength(1);
		expect(host.mock.calls("fs.read")).toHaveLength(0);
	});

	it("非 WAV 且没配远端 → 给两条可执行出路，而不是撞一次 415", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { tool } = boot({}, { "memo.m4a": new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]) });
		const out = String(await tool().execute("id", { path: "memo.m4a" }));
		expect(out).toContain("不是 WAV");
		expect(out).toContain("转写接口基址");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("WAV + 远端引擎 → 走 /audio/transcriptions 并回文本", async () => {
		const fetchSpy = stubRemote("会议纪要内容");
		const { tool } = boot(REMOTE_CFG, { "meeting.wav": makeWav() });
		const out = await tool().execute("id", { path: "meeting.wav" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: FormData }];
		expect(url).toBe("https://example.test/v1/audio/transcriptions");
		expect(init.body.get("model")).toBe("whisper-1");
		expect((init.body.get("file") as File).name).toBe("voice.wav");
		expect(out.content[0].text).toBe("会议纪要内容");
		expect(out.details).toMatchObject({ engine: "remote", path: "meeting.wav", chars: 6 });
	});

	it("非 WAV + 配了远端 → 直接走远端，不让本地白撞一次「只要 WAV」", async () => {
		const fetchSpy = stubRemote("转写好了");
		const { host, tool } = boot(REMOTE_CFG, { "memo.m4a": new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]) });
		host.storage.set("whisperModels", { [LOCAL_MODELS.base]: true });
		const out = await tool().execute("id", { path: "memo.m4a" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: FormData }];
		expect((init.body.get("file") as File).name).toBe("voice.m4a");
		expect(out.details.engine).toBe("remote");
	});

	it("WAV + engine=local 但本地没装 → 人话提示去装本地 Whisper", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { tool } = boot({ engine: "local" }, { "meeting.wav": makeWav() });
		const out = String(await tool().execute("id", { path: "meeting.wav" }));
		expect(out).toContain("本地 Whisper 还没装");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("空文件 → 直接说明，不去调引擎", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { tool } = boot(REMOTE_CFG, { "empty.wav": new Uint8Array(0) });
		const out = String(await tool().execute("id", { path: "empty.wav" }));
		expect(out).toContain("空文件");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("ensureSharpStub & hasCachedModelOnDisk", () => {
	it("sharp 缺失原生 .node 绑定时自动注入内存 stub，使 require('sharp') 返回真值函数而不崩", () => {
		const tmp = mkdtempSync(join(tmpdir(), "voice-sharp-stub-"));
		cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
		const sharpDir = join(tmp, "node_modules", "sharp", "lib");
		mkdirSync(sharpDir, { recursive: true });
		writeFileSync(
			join(tmp, "node_modules", "sharp", "package.json"),
			JSON.stringify({ name: "sharp", main: "lib/index.js" }),
		);
		writeFileSync(
			join(sharpDir, "sharp.js"),
			`throw new Error("Something went wrong installing the \\"sharp\\" module\\nCannot find module '../build/Release/sharp-win32-x64.node'");\n`,
		);
		writeFileSync(join(sharpDir, "index.js"), `module.exports = require("./sharp.js");\n`);
		const entry = join(tmp, "index.mjs");
		writeFileSync(entry, "export default {};\n");

		expect(ensureSharpStub(entry)).toBe(true);
		const req = createRequire(entry);
		const loaded = req("sharp");
		expect(typeof loaded).toBe("function");
		expect(() => loaded()).toThrow("unavailable");
		expect(ensureSharpStub(entry)).toBe(false);
	});

	it("hasCachedModelOnDisk 探测 config.json + onnx/*.onnx，且 localReady 自动从磁盘恢复 storage 标记", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "voice-cache-heal-"));
		cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
		const cacheDir = join(tmp, "whisper-cache");
		expect(hasCachedModelOnDisk(cacheDir, LOCAL_MODELS.base)).toBe(false);

		const modelDir = join(cacheDir, "Xenova", "whisper-base");
		mkdirSync(join(modelDir, "onnx"), { recursive: true });
		writeFileSync(join(modelDir, "config.json"), "{}");
		expect(hasCachedModelOnDisk(cacheDir, LOCAL_MODELS.base)).toBe(false);

		writeFileSync(join(modelDir, "onnx", "encoder_model_quantized.onnx"), "onnx");
		expect(hasCachedModelOnDisk(cacheDir, LOCAL_MODELS.base)).toBe(true);

		const host = createMockHost({ dir: tmp, settings: { engine: "local", localModel: "base" } });
		const off = voiceInput.activate(host);
		cleanups.push(() => off());
		const statusRoute = host.mock.routes.find(
			(r: { method: string; path: string }) => r.method === "GET" && r.path === "/local-status",
		);
		const res = {
			statusCode: 200,
			headersSent: false,
			body: null as Record<string, unknown> | null,
			status() {
				return this;
			},
			json(p: Record<string, unknown>) {
				this.body = p;
				return this;
			},
			end() {
				return this;
			},
		};
		await statusRoute.handler({}, res);
		expect(res.body?.ready).toBe(true);
		expect(host.storage.get("whisperModels")).toEqual({ [LOCAL_MODELS.base]: true });
	});
});
