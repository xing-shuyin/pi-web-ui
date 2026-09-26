/**
 * voice-input 插件单测 —— 走真实源码路径，不 mock 被测逻辑。
 *
 * 覆盖：
 *   - manifest.json：view:false（无独立视图 tab）+ apiVersion 2 + permissions
 *     含 ui/http/fs:read/tools（严格模式下 composer 条目、host.route、host.fs.read 与
 *     host.registerAgentTool 缺一不可）。
 *   - manifest "ui" 经服务端真实 `parseUiContributions` 解析：恰好一条，
 *     落在 composer.actions，kind=action，action=voice-input:toggle。
 *   - settings schema：lang 默认 zh-CN、serverFallback 默认开、转写三件套齐全、
 *     engine 默认 auto、localModel 默认 base。
 *   - 服务端纯函数：whisperLang（远端 ISO-639-1）、whisperFullLang（本地英文全名）、
 *     joinUrl、resolveLocalModel（白名单）、resampleLinear、decodeWav16k。
 *   - 客户端 encodeWavPCM（entry.mjs 纯函数导出）→ 服务端 decodeWav16k 往返 +
 *     srExplain 错误码映射。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUiContributions } from "../../server/plugins.js";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import voiceInput, {
	decodeWav16k,
	hfEndpointHost,
	joinUrl,
	LOCAL_MODELS,
	pkgEntryCandidates,
	resampleLinear,
	resolveLocalModel,
	whisperFullLang,
	whisperLang,
} from "../../plugins/voice-input/index.mjs";
import { encodeWavPCM, pickEngineRoute, srExplain, srTotalText } from "../../plugins/voice-input/client/entry.mjs";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "voice-input");
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));

describe("voice-input manifest", () => {
	it("无独立视图 + 严格模式能力声明齐全", () => {
		expect(manifest.id).toBe("voice-input");
		expect(manifest.view).toBe(false);
		expect(manifest.apiVersion).toBe(2);
		expect(manifest.permissions).toContain("ui");
		expect(manifest.permissions).toContain("http");
		// fs:read 是 transcribe_audio 读工作区文件的前提（缺它 host.fs.read 直接拒）。
		expect(manifest.permissions).toContain("fs:read");
		// tools 是 host.registerAgentTool 的硬门控（缺它注册点直接 return，transcribe_audio
		// 永远不注册）。这条以前没断言，所以缺声明时测试是绿的（issue #146 收口时补的断言）。
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
		// icon 必须是宿主图标词表名（ChatInput 只认 mic/camera 两个词），
		// 写别的会被当文字直接画在按钮上。
		expect([mic.icon, cam.icon].sort()).toEqual(["camera", "mic"]);
	});

	it("settings 有语言/降级开关/转写三件套且默认值对", () => {
		const byKey = Object.fromEntries(manifest.settings.map((f: { key: string }) => [f.key, f]));
		expect(byKey.lang.default).toBe("zh-CN");
		expect(byKey.serverFallback.default).toBe(true);
		expect(byKey.transcribeUrl.default).toBe("");
		expect(byKey.transcribeKey.type).toBe("password");
		expect(byKey.transcribeModel.default).toBe("whisper-1");
		// 给 AI 的转写工具：默认开，可在设置里下架（插件工具不进 AGENT_TOOL_CATALOG，
		// 设置里也没有它的独立开关，所以这个插件设置就是它唯一的「下架」入口）。
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
		// 模型下载源（issue #383）：国内直连 huggingface.co 会超时，留空 = 官方源。
		expect(byKey.hfEndpoint.type).toBe("text");
		expect(byKey.hfEndpoint.default).toBe("");
	});
});

/* ------------------------------------------------------------------ */
/* 引擎分流（issue #383：不再「先试浏览器联网、失败才降级」）              */
/* ------------------------------------------------------------------ */

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
		// 服务端就绪但降级开关关着：说清楚是开关的事，不弹安装。
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
			src.indexOf("/* ---", src.indexOf("async function toggle()")),
		);
		expect(toggle).toContain("startByEngine(cfg)");
		// 旧写法「先试 srSupported() 再降级」不许回潮。
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
		// 相对路径原样保留（join 吃得下 "./" 前缀），不在这里做形状归一。
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
		expect(hfEndpointHost("")).toBe("");
		expect(hfEndpointHost(undefined, "")).toBe("");
		expect(hfEndpointHost("file:///etc/passwd")).toBe("");
		expect(hfEndpointHost("ftp://x.example")).toBe("");
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
	/** 手拼 16-bit PCM WAV（声道数/采样率可调，含一个 JUNK 块考验跳块）。 */
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
});

describe("引擎切换路由（POST /engine）", () => {
	/** 抓插件注册的真路由处理器（走 activate 真路径，不 mock 被测逻辑）。 */
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
		// 其它设置项不能被抹掉（也不该把合并后的默认值固化成存值）。
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

/* ------------------------------------------------------------------ */
/* transcribe_audio（本次新增的 AI 工具）                                 */
/* ------------------------------------------------------------------ */

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	vi.restoreAllMocks();
});

/** 16k 单声道 WAV：直接用客户端那支真编码器，别再手搓 header。 */
const makeWav = (samples = 16000) => encodeWavPCM(new Float32Array(samples), 16000);

/** 起一个激活态插件；files 决定 host.fs.read / readPath 的行为。 */
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

/** 远端接口打桩：成功回一段文本，并记录调用参数。 */
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
		// 不说这句模型不会想到用它。
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
		// 反复打开不应留下重复注册（重名会被宿主拒掉，但那时按钮已经下架过）。
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
		// 文件部件要带 .wav 后缀：远端接口按它判容器格式。
		expect((init.body.get("file") as File).name).toBe("voice.wav");
		expect(out.content[0].text).toBe("会议纪要内容");
		expect(out.details).toMatchObject({ engine: "remote", path: "meeting.wav", chars: 6 });
	});

	it("非 WAV + 配了远端 → 直接走远端，不让本地白撞一次「只要 WAV」", async () => {
		const fetchSpy = stubRemote("转写好了");
		const { host, tool } = boot(REMOTE_CFG, { "memo.m4a": new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]) });
		// 本地也装着：这正是最容易写错的组合（auto 档会先挑本地，而本地只吃 WAV）。
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
