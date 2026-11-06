import { describe, expect, it } from "vitest";
import {
	PRESETS,
	defaultConfig,
	maskConfig,
	normalizeConfig,
	normalizeService,
	pickService,
	presetService,
	secretKey,
} from "../../plugins/image-toolkit/core/gen-config.mjs";
import { buildMultipart, formFields } from "../../plugins/image-toolkit/core/gen-multipart.mjs";
import { extForImage, planOutputPaths } from "../../plugins/image-toolkit/core/gen-output.mjs";
import * as U from "../../plugins/image-toolkit/core/gen-util.mjs";

function pngBytes(n = 96) {
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]);
}

describe("工具函数", () => {
	it("画幅归一：比例写法都认，像素写法折算到最近标准比例", () => {
		expect(U.normalizeAspect("16:9")).toBe("16:9");
		expect(U.normalizeAspect("16x9")).toBe("16:9");
		expect(U.normalizeAspect("16/9")).toBe("16:9");
		expect(U.normalizeAspect("1920x1080")).toBe("16:9");
		expect(U.normalizeAspect("1024x1024")).toBe("1:1");
		expect(U.normalizeAspect("7:5")).toBe("");
		expect(U.normalizeAspect("")).toBe("");
	});

	it("画幅 + 画质 → 像素（1k/2k/4k 与 Google 口径一致；WxH 原样）", () => {
		expect(U.pixelsFor("1:1", "1k")).toMatchObject({ width: 1024, height: 1024 });
		expect(U.pixelsFor("16:9", "2k")).toMatchObject({ width: 2752, height: 1536 });
		expect(U.pixelsFor("9:16", "4k")).toMatchObject({ width: 3072, height: 5504 });
		expect(U.pixelsFor("1920x1080", "1k")).toMatchObject({ width: 1920, height: 1080, aspect: "16:9" });
		expect(U.pixelsFor("", "")).toMatchObject({ width: 1024, height: 1024, aspect: "1:1" });
	});

	it("画质归一与标签", () => {
		expect(U.normalizeQuality("standard")).toBe("1k");
		expect(U.normalizeQuality("2K")).toBe("2k");
		expect(U.normalizeQuality("hd")).toBe("4k");
		expect(U.normalizeQuality("whatever")).toBe("");
		expect(U.qualityLabel("2k")).toBe("2K");
		expect(U.qualityLabel("nope")).toBe("");
	});

	it("slug 与文件名模板", () => {
		expect(U.slugify("a red apple / on white!! ")).toBe("a-red-apple-on-white");
		expect(U.slugify('bad<>:"|?*name')).toBe("bad-name");
		expect(U.slugify("中文提示词 画一只猫")).toBe("中文提示词-画一只猫");
		expect(U.slugify("")).toBe("");
		const name = U.filenameFromTemplate("{date}-{slug}", { slug: "a cat", now: new Date(2026, 0, 2, 3, 4, 5) });
		expect(name).toBe("20260102-a-cat");
		expect(U.filenameFromTemplate("{stamp}-{model}", { model: "gpt image 1", now: new Date(2026, 0, 2) })).toContain(
			"gpt-image-1",
		);
		expect(U.filenameFromTemplate("{nope}", {})).toBe("nope");
	});

	it("相对路径与体积", () => {
		expect(U.normalizeRel(".\\a\\b.png")).toBe("a/b.png");
		expect(U.normalizeRel("/x//y.png")).toBe("x/y.png");
		expect(U.joinRel("generated", "/a.png")).toBe("generated/a.png");
		expect(U.joinRel("", "a.png")).toBe("a.png");
		expect(U.fmtBytes(2048)).toBe("2.0 KB");
		expect(U.fmtBytes(3 * 1024 * 1024)).toBe("3.00 MB");
	});

	it("base64 / data URI / 文件头嗅探", () => {
		expect(U.b64ToBuffer(pngBytes().toString("base64")).length).toBe(pngBytes().length);
		expect(U.parseDataUri(`data:image/png;base64,${pngBytes().toString("base64")}`)?.mimeType).toBe("image/png");
		expect(U.parseDataUri("nope")).toBe(null);
		expect(U.sniffImageMime(pngBytes())).toBe("image/png");
		expect(U.sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
		expect(U.sniffImageMime(Buffer.from("RIFF____WEBPVP8 "))).toBe("image/webp");
		expect(U.sniffImageMime(Buffer.from("hello world hello"))).toBe("");
		expect(U.mimeToExt("image/jpeg")).toBe("jpg");
		expect(U.mimeToExt("application/octet-stream")).toBe("bin");
		expect(U.extToMime(".png")).toBe("image/png");
	});

	it("杂项：整数夹取、id 归一、截断、随机 hex", () => {
		expect(U.clampInt("5", 1, 3, 1)).toBe(3);
		expect(U.clampInt("x", 1, 3, 2)).toBe(2);
		expect(U.slugId("My Service!", "svc")).toBe("my-service");
		expect(U.slugId("", "svc")).toBe("svc");
		expect(U.truncate("abcdef", 3)).toBe("abc…");
		expect(U.randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
		expect(U.str(null)).toBe("");
		expect(U.trimSlash("http://x/v1/")).toBe("http://x/v1");
	});
});

describe("multipart 编码", () => {
	it("普通字段与文件字段都能编码，边界可断言", () => {
		const { body, contentType, boundary } = buildMultipart(
			[
				{ name: "prompt", value: "hi" },
				{ name: "image1", filename: "a.png", contentType: "image/png", data: pngBytes() },
			],
			"BOUND",
		);
		expect(contentType).toBe("multipart/form-data; boundary=BOUND");
		const text = body.toString("latin1");
		expect(text).toContain('--BOUND\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nhi\r\n');
		expect(text).toContain('filename="a.png"');
		expect(text.endsWith("--BOUND--\r\n")).toBe(true);
		expect(boundary).toBe("BOUND");
	});

	it("非法字段名直接拒绝（防注入畸形 header）", () => {
		expect(() => buildMultipart([{ name: 'x"\r\nInjected: 1', value: "1" }])).toThrow(/非法字段名/);
	});

	it("formFields：跳过空值、对象 JSON 化", () => {
		expect(formFields({ a: 1, b: "", c: null, d: { x: 1 } })).toEqual([
			{ name: "a", value: "1" },
			{ name: "d", value: '{"x":1}' },
		]);
	});
});

describe("配置归一化", () => {
	it("空配置回默认（目录 generated / 模板 / 回图开启 / 超时 300s）", () => {
		expect(normalizeConfig(null)).toEqual(defaultConfig());
		expect(normalizeConfig({ services: "nope", outputDir: 42 }).services).toEqual([]);
	});

	it("服务字段脏值逐个回默认，数字夹取", () => {
		const cfg = normalizeConfig({
			services: [
				{
					id: "A Bad ID",
					shape: "nope",
					baseUrl: "http://x/v1///",
					models: ["m1", "m1", " m2 "],
					defaultModel: "",
					timeoutSec: 99999,
					maxImages: 999,
					sizes: [],
					qualities: [],
					extraBody: "{bad json",
				},
			],
		});
		const s = cfg.services[0]!;
		expect(s.id).toBe("a-bad-id");
		expect(s.shape).toBe("openai-images");
		expect(s.baseUrl).toBe("http://x/v1");
		expect(s.models).toEqual(["m1", "m2"]);
		expect(s.defaultModel).toBe("m1");
		expect(s.timeoutSec).toBe(1800);
		expect(s.sizes.length).toBeGreaterThan(0);
		expect(s.extraBody).toEqual({});
		expect(cfg.maxImages).toBeLessThanOrEqual(8);
	});

	it("服务 id 冲突加后缀，不覆盖", () => {
		const cfg = normalizeConfig({ services: [{ id: "dup" }, { id: "dup" }, { id: "dup" }] });
		expect(cfg.services.map((s) => s.id)).toEqual(["dup", "dup-2", "dup-3"]);
	});

	it("换形状丢弃上一个形状的专属字段", () => {
		const comfy = normalizeService({ id: "c", shape: "comfyui", workflow: "{}", sizeMap: { "1:1": "512x512" } });
		expect(comfy.workflow).toBe("{}");
		const back = normalizeService({ ...comfy, shape: "openai-images" });
		expect(back.workflow).toBeUndefined();
		expect(back.editFields).toBeDefined();
		expect(back.sizeMap).toEqual({ "1:1": "512x512" });
	});

	it("默认服务指向已删服务时清空；pickService 回落默认→第一个启用", () => {
		const cfg = normalizeConfig({
			defaultService: "gone",
			services: [{ id: "a2" }, { id: "b2", enabled: false }],
		});
		expect(cfg.defaultService).toBe("");
		expect(pickService(cfg, "b2")).toBe(null);
		expect(pickService(cfg, "")?.id).toBe("a2");
		expect(pickService(cfg, "nope")?.id).toBe("a2");
		const cfg2 = normalizeConfig({ defaultService: "b3", services: [{ id: "a3" }, { id: "b3" }] });
		expect(pickService(cfg2, "")?.id).toBe("b3");
		expect(pickService(cfg2, "a3")?.id).toBe("a3");
	});

	it("脱敏：下发视图的配置里没有密钥明文，只有 hasKey", () => {
		const cfg = normalizeConfig({ services: [{ id: "s1", apiKey: "sk-plaintext" }, { id: "s2" }] });
		const masked = maskConfig(cfg, (id: string) => id === "s1");
		expect(masked.services[0]!.hasKey).toBe(true);
		expect(masked.services[1]!.hasKey).toBe(false);
		expect(JSON.stringify(masked)).not.toContain("sk-plaintext");
		expect(secretKey("s1")).toBe("svc:s1");
	});
});

describe("预置模板", () => {
	it("每个预置都能归一成合法服务（含 baseUrl 与形状）", () => {
		for (const p of PRESETS) {
			const svc = presetService(p.id, []);
			expect(svc.id).toBe(p.id);
			expect(["openai-images", "gemini", "openrouter-chat", "stability", "comfyui"]).toContain(svc.shape);
			expect(svc.baseUrl).toMatch(/^https?:\/\//);
			expect(svc.name.length).toBeGreaterThan(0);
		}
	});

	it("id 冲突时加后缀；未知预置回落到最后一个模板", () => {
		expect(presetService("openai", ["openai"]).id).toBe("openai-2");
		expect(presetService("openai", ["openai", "openai-2"]).id).toBe("openai-3");
		const fallback = presetService("no-such-preset", []);
		expect(fallback.shape).toBe("openai-images");
	});

	it("本地 Antigravity 预置：8045 端点、indexed 图生图字段、不需要 response_format", () => {
		const svc = presetService("antigravity", []);
		expect(svc.baseUrl).toBe("http://127.0.0.1:8045/v1");
		expect(svc.editFields).toBe("indexed");
		expect(svc.responseFormat).toBe("omit");
		expect(svc.defaultModel).toBe("gemini-3.1-flash-image");
	});

	it("模板改不到模块级常量（返回深拷贝）", () => {
		const a = presetService("openai", []);
		a.models.push("hacked");
		expect(PRESETS.find((p) => p.id === "openai")!.service.models).not.toContain("hacked");
	});
});

describe("输出路径规划", () => {
	const img = { data: pngBytes(), mimeType: "image/png" };

	it("按目录 + 模板落盘，扩展名取自字节嗅探", async () => {
		expect(extForImage(img)).toBe("png");
		expect(extForImage({ data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), mimeType: "" })).toBe(
			"jpg",
		);
		const plan = await planOutputPaths({
			images: [img],
			outputDir: "generated",
			template: "{date}-{slug}",
			prompt: "a red apple",
			exists: () => false,
		});
		expect(plan[0]!.rel).toMatch(/^generated\/\d{8}-a-red-apple\.png$/);
	});

	it("outDir 覆盖 outputDir；显式 out 只在单图时生效", async () => {
		const plan = await planOutputPaths({
			images: [img],
			out: "art/hero.png",
			outputDir: "generated",
			template: "{slug}",
			prompt: "x",
			exists: () => false,
		});
		expect(plan[0]!.rel).toBe("art/hero.png");

		const multi = await planOutputPaths({
			images: [img, img],
			out: "art/hero",
			outputDir: "generated",
			template: "fix",
			prompt: "x",
			exists: () => false,
		});
		expect(multi.map((p) => p.rel)).toEqual(["art/hero.png", "generated/fix-2.png"]);
	});

	it("同名自动加 -1/-2（查重回调命中时）", async () => {
		const taken = new Set(["generated/a.png", "generated/a-1.png"]);
		const plan = await planOutputPaths({
			images: [img],
			outDir: "generated",
			template: "a",
			prompt: "x",
			exists: async (rel: string) => taken.has(rel),
		});
		expect(plan[0]!.rel).toBe("generated/a-2.png");
	});

	it("多图加序号后缀", async () => {
		const plan = await planOutputPaths({
			images: [img, img, img],
			outDir: "gen",
			template: "shot",
			prompt: "x",
			exists: () => false,
		});
		expect(plan.map((p) => p.rel)).toEqual(["gen/shot-1.png", "gen/shot-2.png", "gen/shot-3.png"]);
	});
});
