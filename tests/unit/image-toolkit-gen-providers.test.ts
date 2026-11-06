import { describe, expect, it } from "vitest";
import {
	ProviderError,
	SHAPE_LIST,
	buildRequest,
	generateImage,
	parseResponse,
	probeService,
	renderComfyWorkflow,
} from "../../plugins/image-toolkit/core/gen-providers.mjs";
import { normalizeService } from "../../plugins/image-toolkit/core/gen-config.mjs";

function pngBytes(n = 96) {
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]);
}
function jpegBytes(n = 96) {
	return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
}
const b64 = (b: Buffer) => b.toString("base64");

function jsonRes(obj: unknown, status = 200) {
	const text = JSON.stringify(obj);
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Err",
		headers: { get: (k: string) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
		arrayBuffer: async () => Uint8Array.from(Buffer.from(text, "utf8")).buffer,
	};
}
function binRes(buf: Buffer, mime = "image/png", status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: "OK",
		headers: { get: (k: string) => (String(k).toLowerCase() === "content-type" ? mime : null) },
		arrayBuffer: async () => Uint8Array.from(buf).buffer,
	};
}

function makeFetch(routes: Array<[string | RegExp, (url: string, init: any) => unknown]>) {
	const calls: Array<{ url: string; init: any }> = [];
	const fetchImpl = async (url: string, init: any) => {
		calls.push({ url, init });
		for (const [pattern, handler] of routes) {
			const hit = typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
			if (hit) return handler(url, init);
		}
		throw new Error(`fetch stub 未覆盖：${url}`);
	};
	return { calls, fetch: fetchImpl as unknown as typeof globalThis.fetch };
}

const AGY = normalizeService({
	id: "antigravity",
	name: "本地 Antigravity",
	shape: "openai-images",
	baseUrl: "http://127.0.0.1:8045/v1",
	models: ["gemini-3.1-flash-image"],
	sizes: ["1:1", "16:9"],
	defaultSize: "1:1",
	qualities: ["1k", "2k", "4k"],
	defaultQuality: "2k",
	editFields: "indexed",
	responseFormat: "omit",
});

describe("形状目录", () => {
	it("五种形状都在，且字段/能力声明齐全", () => {
		expect(SHAPE_LIST.map((s) => s.id)).toEqual(["openai-images", "gemini", "openrouter-chat", "stability", "comfyui"]);
		for (const s of SHAPE_LIST) {
			expect(s.label.length).toBeGreaterThan(0);
			expect(s.defaultBaseUrl).toMatch(/^https?:\/\//);
			expect(Array.isArray(s.fields)).toBe(true);
			expect(typeof s.caps.edit).toBe("boolean");
		}
	});
});

describe("openai-images 形状", () => {
	it("文生图：路径、鉴权头、请求体字段（responseFormat=omit 时不带 response_format）", () => {
		const req = buildRequest(
			"openai-images",
			AGY,
			{ prompt: "a cat", model: "gemini-3.1-flash-image", size: "16:9", quality: "2k", n: 2 },
			"sk-key",
		)!;
		expect(req.url).toBe("http://127.0.0.1:8045/v1/images/generations");
		expect(req.method).toBe("POST");
		expect((req.headers as any).Authorization).toBe("Bearer sk-key");
		expect((req.headers as any)["Content-Type"]).toBe("application/json");
		const body = JSON.parse(String(req.body));
		expect(body).toEqual({
			prompt: "a cat",
			model: "gemini-3.1-flash-image",
			n: 2,
			size: "16:9",
			quality: "2k",
		});
	});

	it("responseFormat=b64_json/url 时才带 response_format；sizeMap/qualityMap 生效", () => {
		const svc = normalizeService({
			...AGY,
			responseFormat: "url",
			sizeMap: { "1:1": "1024x1024" },
			qualityMap: { "2k": "medium" },
		});
		const req = buildRequest("openai-images", svc, { prompt: "x", size: "1:1", quality: "2k" }, "k")!;
		const body = JSON.parse(String(req.body));
		expect(body.size).toBe("1024x1024");
		expect(body.quality).toBe("medium");
		expect(body.response_format).toBe("url");
	});

	it("图生图（editFields=indexed）：multipart 用 image1/image2 且不带 image[]", () => {
		const req = buildRequest(
			"openai-images",
			AGY,
			{
				prompt: "make it watercolor",
				refs: [
					{ name: "a.png", mimeType: "image/png", data: pngBytes() },
					{ name: "b.png", mimeType: "image/png", data: pngBytes() },
				],
				size: "1:1",
			},
			"k",
		)!;
		expect(req.url).toBe("http://127.0.0.1:8045/v1/images/edits");
		const ct = String((req.headers as any)["Content-Type"]);
		expect(ct).toMatch(/^multipart\/form-data; boundary=/);
		const text = Buffer.from(req.body as Buffer).toString("latin1");
		expect(text).toContain('name="image1"; filename="a.png"');
		expect(text).toContain('name="image2"; filename="b.png"');
		expect(text).not.toContain('name="image[]"');
		expect(text).toContain('name="prompt"');
		expect(text).toContain("make it watercolor");
	});

	it("图生图（editFields=openai）：image + image[] 字段名", () => {
		const svc = normalizeService({ ...AGY, editFields: "openai" });
		const req = buildRequest(
			"openai-images",
			svc,
			{
				prompt: "p",
				refs: [
					{ name: "a.png", mimeType: "image/png", data: pngBytes() },
					{ name: "b.png", mimeType: "image/png", data: pngBytes() },
				],
			},
			"k",
		)!;
		const text = Buffer.from(req.body as Buffer).toString("latin1");
		expect(text).toContain('name="image"; filename="a.png"');
		expect(text).toContain('name="image[]"; filename="b.png"');
		expect(text).not.toContain('name="image1"');
	});

	it("解析 b64_json 多条 + revised_prompt", async () => {
		const out = await parseResponse("openai-images", {
			kind: "json",
			json: { data: [{ b64_json: b64(pngBytes()), revised_prompt: "better" }, { b64_json: b64(jpegBytes()) }] },
			buf: Buffer.alloc(0),
			ct: "application/json",
		});
		expect(out.images).toHaveLength(2);
		expect(out.images[0].mimeType).toBe("image/png");
		expect(out.images[1].mimeType).toBe("image/jpeg");
		expect(out.text).toBe("better");
	});

	it("解析 url 形式：会再发一次 GET 把图下回来", async () => {
		const { calls, fetch } = makeFetch([["https://cdn.test/a.jpg", () => binRes(jpegBytes(), "image/jpeg")]]);
		const out = await parseResponse(
			"openai-images",
			{
				kind: "json",
				json: { data: [{ url: "https://cdn.test/a.jpg" }] },
				buf: Buffer.alloc(0),
				ct: "application/json",
			},
			{ deps: { fetch } },
		);
		expect(out.images[0].mimeType).toBe("image/jpeg");
		expect(calls[0].url).toBe("https://cdn.test/a.jpg");
	});

	it("生成的 base64 是垃圾时不误判成图片", async () => {
		const out = await parseResponse("openai-images", {
			kind: "json",
			json: { data: [{ b64_json: Buffer.from("not an image at all").toString("base64") }] },
			buf: Buffer.alloc(0),
			ct: "application/json",
		});
		expect(out.images).toHaveLength(0);
	});

	it("HTTP 非 2xx：抛出带状态码与供应商原文的 ProviderError", async () => {
		const { fetch } = makeFetch([["/images/generations", () => jsonRes({ error: { message: "invalid key" } }, 401)]]);
		await expect(generateImage(AGY, { prompt: "x" }, { fetch, key: "bad" })).rejects.toThrow(/401.*invalid key/s);
		await expect(generateImage(AGY, { prompt: "x" }, { fetch, key: "bad" })).rejects.toBeInstanceOf(ProviderError);
	});
});

describe("gemini 形状", () => {
	const GOOGLE = normalizeService({
		id: "google",
		shape: "gemini",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		models: ["gemini-2.5-flash-image", "imagen-4.0-generate-001"],
		defaultModel: "gemini-2.5-flash-image",
		authStyle: "x-goog-api-key",
		sizes: ["1:1"],
		qualities: ["1k", "2k", "4k"],
	});

	it("generateContent：URL、x-goog-api-key、responseModalities 与 imageConfig", () => {
		const req = buildRequest(
			"gemini",
			GOOGLE,
			{ prompt: "a fox", model: "gemini-2.5-flash-image", size: "16:9", quality: "2k" },
			"gk",
		)!;
		expect(req.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
		);
		expect((req.headers as any)["x-goog-api-key"]).toBe("gk");
		const body = JSON.parse(String(req.body));
		expect(body.contents[0].parts[0]).toEqual({ text: "a fox" });
		expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
		expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9", imageSize: "2K" });
	});

	it("参考图进 inlineData；imagen 模型自动改走 predict", () => {
		const withRef = buildRequest(
			"gemini",
			GOOGLE,
			{
				prompt: "p",
				model: "gemini-2.5-flash-image",
				refs: [{ name: "r.png", mimeType: "image/png", data: pngBytes() }],
			},
			"gk",
		)!;
		const parts = JSON.parse(String(withRef.body)).contents[0].parts;
		expect(parts[1].inlineData.mimeType).toBe("image/png");
		expect(parts[1].inlineData.data).toBe(b64(pngBytes()));

		const imagen = buildRequest(
			"gemini",
			GOOGLE,
			{ prompt: "p", model: "imagen-4.0-generate-001", size: "3:2" },
			"gk",
		)!;
		expect(imagen.url).toContain("imagen-4.0-generate-001:predict");
		const body = JSON.parse(String(imagen.body));
		expect(body.instances).toEqual([{ prompt: "p" }]);
		expect(body.parameters).toMatchObject({ sampleCount: 1, aspectRatio: "3:2" });
	});

	it("解析 inlineData（camel）与 inline_data（snake）都给图", async () => {
		const out = await parseResponse("gemini", {
			kind: "json",
			json: {
				candidates: [
					{
						content: {
							parts: [
								{ text: "here you go" },
								{ inlineData: { mimeType: "image/png", data: b64(pngBytes()) } },
								{ inline_data: { mime_type: "image/jpeg", data: b64(jpegBytes()) } },
							],
						},
					},
				],
			},
			buf: Buffer.alloc(0),
			ct: "application/json",
		});
		expect(out.images.map((i: any) => i.mimeType)).toEqual(["image/png", "image/jpeg"]);
		expect(out.text).toBe("here you go");
	});

	it("安全拦截：没有图但 finishReason=IMAGE_SAFETY 时给出原因", async () => {
		const out = await parseResponse("gemini", {
			kind: "json",
			json: {
				candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [{ text: "blocked" }] } }],
				promptFeedback: { blockReason: "SAFETY" },
			},
			buf: Buffer.alloc(0),
			ct: "application/json",
		});
		expect(out.images).toHaveLength(0);
		expect(out.text).toMatch(/SAFETY/);
		expect(out.meta.blocked).toBe(true);
		await expect(
			generateImage(
				GOOGLE,
				{ prompt: "x" },
				{
					fetch: makeFetch([["/models/", () => jsonRes({ candidates: [{ finishReason: "IMAGE_SAFETY" }] })]]).fetch,
					key: "k",
				},
			),
		).rejects.toThrow(/安全策略|SAFETY/);
	});

	it("imagen predict 的预测结果（bytesBase64Encoded）能解析", async () => {
		const out = await parseResponse("gemini", {
			kind: "json",
			json: { predictions: [{ bytesBase64Encoded: b64(pngBytes()) }] },
			buf: Buffer.alloc(0),
			ct: "application/json",
		});
		expect(out.images).toHaveLength(1);
		expect(out.images[0].mimeType).toBe("image/png");
	});
});

describe("openrouter-chat 形状", () => {
	const OR = normalizeService({
		id: "openrouter",
		shape: "openrouter-chat",
		baseUrl: "https://openrouter.ai/api/v1",
		models: ["google/gemini-2.5-flash-image"],
		defaultModel: "google/gemini-2.5-flash-image",
	});

	it("请求体走 chat/completions + modalities，参考图作为 data URI", () => {
		const req = buildRequest(
			"openrouter-chat",
			OR,
			{ prompt: "p", model: "m", refs: [{ name: "r.png", mimeType: "image/png", data: pngBytes() }] },
			"k",
		)!;
		expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		const body = JSON.parse(String(req.body));
		expect(body.modalities).toEqual(["image", "text"]);
		expect(body.messages[0].content[0]).toEqual({ type: "text", text: "p" });
		expect(body.messages[0].content[1].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("解析 message.images[]（data URI）与正文", async () => {
		const out = await parseResponse("openrouter-chat", {
			kind: "json",
			json: {
				choices: [
					{
						message: {
							content: "done",
							images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64(pngBytes())}` } }],
						},
					},
				],
			},
			buf: Buffer.alloc(0),
			ct: "application/json",
		});
		expect(out.images).toHaveLength(1);
		expect(out.text).toBe("done");
	});

	it("模型把图塞进 markdown 正文也能捞出来", async () => {
		const { fetch } = makeFetch([["https://cdn.test/x.png", () => binRes(pngBytes())]]);
		const out = await parseResponse(
			"openrouter-chat",
			{
				kind: "json",
				json: { choices: [{ message: { content: "Here: ![img](https://cdn.test/x.png)" } }] },
				buf: Buffer.alloc(0),
				ct: "application/json",
			},
			{ deps: { fetch } },
		);
		expect(out.images).toHaveLength(1);
	});
});

describe("stability 形状", () => {
	const ST = normalizeService({
		id: "stability",
		shape: "stability",
		baseUrl: "https://api.stability.ai",
		endpoint: "core",
		outputFormat: "webp",
	});

	it("multipart 字段与端点；negative/seed 也进表单", () => {
		const req = buildRequest("stability", ST, { prompt: "p", size: "3:2", negative: "blur", seed: 42 }, "k")!;
		expect(req.url).toBe("https://api.stability.ai/v2beta/stable-image/generate/core");
		expect((req.headers as any).accept).toBe("image/*");
		const text = Buffer.from(req.body as Buffer).toString("latin1");
		expect(text).toContain('name="prompt"');
		expect(text).toContain('name="output_format"');
		expect(text).toContain("webp");
		expect(text).toContain('name="aspect_ratio"');
		expect(text).toContain("3:2");
		expect(text).toContain("blur");
		expect(text).toContain("42");
	});

	it("二进制响应直接收字节；JSON 的 finish_reason 非 SUCCESS 视为拦截", async () => {
		const bin = await parseResponse("stability", { kind: "binary", json: null, buf: pngBytes(), ct: "image/png" });
		expect(bin.images[0].mimeType).toBe("image/png");
		const filtered = await parseResponse("stability", {
			kind: "json",
			json: { image: b64(pngBytes()), finish_reason: "CONTENT_FILTERED" },
			buf: Buffer.alloc(0),
			ct: "application/json",
		});
		expect(filtered.images).toHaveLength(0);
		expect(filtered.text).toContain("CONTENT_FILTERED");
	});
});

describe("comfyui 形状", () => {
	it("workflow 占位符替换：字符串 JSON 转义、裸数字原样、未知占位保留", () => {
		const wf = renderComfyWorkflow(
			JSON.stringify({
				"1": { inputs: { text: "{{prompt}}", negative: "{{negative}}" } },
				"2": { inputs: { width: "{{width}}", height: "{{height}}", batch_size: "{{batch}}", seed: "{{seed}}" } },
				"3": { inputs: { note: "{{nope}}" } },
			}),
			{ prompt: 'a "quoted" line\nsecond', negative: "blur", size: "16:9", quality: "2k", n: 2, seed: 7 },
		);
		expect(wf["1"].inputs.text).toBe('a "quoted" line\nsecond');
		expect(wf["1"].inputs.negative).toBe("blur");
		expect(wf["2"].inputs.width).toBe("2752");
		expect(wf["2"].inputs.height).toBe("1536");
		expect(wf["2"].inputs.batch_size).toBe("2");
		expect(wf["2"].inputs.seed).toBe("7");
		expect(wf["3"].inputs.note).toBe("{{nope}}");
	});

	it("全流程：上传参考图 → /prompt → 轮询 /history → /view 取图", async () => {
		const svc = normalizeService({
			id: "comfy",
			shape: "comfyui",
			baseUrl: "http://127.0.0.1:8188",
			workflow: JSON.stringify({ "1": { inputs: { text: "{{prompt}}", image: "{{image1}}" } } }),
			authStyle: "none",
		});
		const { calls, fetch } = makeFetch([
			["/upload/image", () => jsonRes({ name: "ref_0001.png", subfolder: "", type: "input" })],
			["/prompt", (_u, init) => jsonRes({ prompt_id: "pid-1" })],
			[
				"/history/pid-1",
				() =>
					jsonRes({
						"pid-1": { outputs: { "9": { images: [{ filename: "out_1.png", subfolder: "", type: "output" }] } } },
					}),
			],
			["/view?", () => binRes(pngBytes())],
		]);
		const out = await generateImage(
			svc,
			{ prompt: "a cat", refs: [{ name: "ref.png", mimeType: "image/png", data: pngBytes() }] },
			{ fetch, timeoutMs: 15_000 },
		);
		expect(out.images).toHaveLength(1);
		expect(out.images[0].mimeType).toBe("image/png");
		const promptBody = JSON.parse(String(calls.find((c) => c.url.endsWith("/prompt"))!.init.body));
		expect(promptBody.prompt["1"].inputs.image).toBe("ref_0001.png");
		expect(promptBody.prompt["1"].inputs.text).toBe("a cat");
		expect(calls.map((c) => c.url)).toEqual([
			"http://127.0.0.1:8188/upload/image",
			"http://127.0.0.1:8188/prompt",
			"http://127.0.0.1:8188/history/pid-1",
			"http://127.0.0.1:8188/view?filename=out_1.png&subfolder=&type=output",
		]);
	});

	it("没有 workflow 时给出可操作的报错", async () => {
		const svc = normalizeService({ shape: "comfyui", baseUrl: "http://127.0.0.1:8188" });
		await expect(generateImage(svc, { prompt: "x" }, { fetch: makeFetch([]).fetch })).rejects.toThrow(/workflow/);
	});

	it("/prompt 返回 node_errors 时把校验错误带出来", async () => {
		const svc = normalizeService({ shape: "comfyui", baseUrl: "http://127.0.0.1:8188", workflow: "{}" });
		const { fetch } = makeFetch([
			[
				"/prompt",
				() =>
					jsonRes(
						{ error: { message: "Prompt outputs failed validation" }, node_errors: { "1": { errors: ["bad"] } } },
						400,
					),
			],
		]);
		await expect(generateImage(svc, { prompt: "x" }, { fetch })).rejects.toThrow(/validation/);
	});
});

describe("generateImage 统一入口", () => {
	it("一次只出一张的形状（gemini）n=2 时并发两次并合并", async () => {
		const svc = normalizeService({
			shape: "gemini",
			baseUrl: "https://g.test/v1beta",
			models: ["m"],
			defaultModel: "m",
			authStyle: "x-goog-api-key",
		});
		const { calls, fetch } = makeFetch([
			[
				":generateContent",
				() =>
					jsonRes({
						candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: b64(pngBytes()) } }] } }],
					}),
			],
		]);
		const out = await generateImage(svc, { prompt: "x", n: 2 }, { fetch, key: "k" });
		expect(calls).toHaveLength(2);
		expect(out.images).toHaveLength(2);
		expect(out.meta.partial).toBe(false);
	});

	it("并发时部分失败：成功的照收，标记 partial", async () => {
		const svc = normalizeService({
			shape: "gemini",
			baseUrl: "https://g.test/v1beta",
			models: ["m"],
			defaultModel: "m",
		});
		let n = 0;
		const { fetch } = makeFetch([
			[
				":generateContent",
				() =>
					n++ === 0
						? jsonRes({
								candidates: [
									{ content: { parts: [{ inlineData: { mimeType: "image/png", data: b64(pngBytes()) } }] } },
								],
							})
						: jsonRes({ error: { message: "quota" } }, 429),
			],
		]);
		const out = await generateImage(svc, { prompt: "x", n: 2 }, { fetch, key: "k" });
		expect(out.images).toHaveLength(1);
		expect(out.meta.partial).toBe(true);
	});

	it("空 prompt / 不支持参考图的形状 / 无图返回都会报错", async () => {
		await expect(generateImage(AGY, { prompt: "  " }, {})).rejects.toThrow(/prompt/);
		const or = normalizeService({ shape: "openrouter-chat", baseUrl: "https://o.test/v1" });
		await expect(
			generateImage(
				or,
				{ prompt: "x" },
				{
					fetch: makeFetch([
						["/chat/completions", () => jsonRes({ choices: [{ message: { content: "no image here" } }] })],
					]).fetch,
				},
			),
		).rejects.toThrow(/未返回图片/);
	});

	it("未知形状回落 openai-images（宽进）", async () => {
		const svc = normalizeService({ id: "weird", shape: "nope", baseUrl: "http://x.test/v1", models: ["m"] });
		expect(svc.shape).toBe("openai-images");
		const { calls, fetch } = makeFetch([
			["/images/generations", () => jsonRes({ data: [{ b64_json: b64(pngBytes()) }] })],
		]);
		const out = await generateImage(svc, { prompt: "x" }, { fetch });
		expect(calls[0].url).toBe("http://x.test/v1/images/generations");
		expect(out.images).toHaveLength(1);
	});

	it("service 的 timeoutSec 决定请求信号（不传 signal 时也有超时）", async () => {
		const svc = normalizeService({ id: "t", shape: "openai-images", baseUrl: "http://x.test/v1", timeoutSec: 30 });
		let sawSignal = false;
		const { fetch } = makeFetch([
			[
				"/images/generations",
				(_u, init) => {
					sawSignal = Boolean(init.signal);
					return jsonRes({ data: [{ b64_json: b64(pngBytes()) }] });
				},
			],
		]);
		await generateImage(svc, { prompt: "x" }, { fetch });
		expect(sawSignal).toBe(true);
	});
});

describe("probeService 连通性探测", () => {
	it("OpenAI 兼容端点：列模型", async () => {
		const { fetch } = makeFetch([["/models", () => jsonRes({ data: [{ id: "gpt-image-1" }, { id: "dall-e-3" }] })]]);
		const out = await probeService(AGY, { fetch, key: "k" });
		expect(out.ok).toBe(true);
		expect(out.models).toEqual(["gpt-image-1", "dall-e-3"]);
	});

	it("Google：models[] 的 name 去掉 models/ 前缀，只留能生图的", async () => {
		const svc = normalizeService({ shape: "gemini", baseUrl: "https://g.test/v1beta", authStyle: "x-goog-api-key" });
		const { fetch } = makeFetch([
			[
				"/models",
				() =>
					jsonRes({
						models: [
							{ name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
							{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
						],
					}),
			],
		]);
		const out = await probeService(svc, { fetch, key: "k" });
		expect(out.models).toEqual(["gemini-2.5-flash-image"]);
	});

	it("ComfyUI：读 system_stats", async () => {
		const svc = normalizeService({ shape: "comfyui", baseUrl: "http://127.0.0.1:8188" });
		const { fetch } = makeFetch([["/system_stats", () => jsonRes({ system: { comfyui_version: "0.3.40" } })]]);
		const out = await probeService(svc, { fetch });
		expect(out.ok).toBe(true);
		expect(out.detail).toContain("0.3.40");
	});

	it("ComfyUI：从 /object_info 抠 checkpoint 清单当模型列表", async () => {
		const svc = normalizeService({ shape: "comfyui", baseUrl: "http://127.0.0.1:8188" });
		const { fetch } = makeFetch([
			["/system_stats", () => jsonRes({ system: { comfyui_version: "0.3.40" } })],
			[
				"/object_info/CheckpointLoaderSimple",
				() =>
					jsonRes({
						CheckpointLoaderSimple: {
							input: { required: { ckpt_name: [["sd_xl_base_1.0.safetensors", "flux1-dev.safetensors"]] } },
						},
					}),
			],
		]);
		const out = await probeService(svc, { fetch });
		expect(out.ok).toBe(true);
		expect(out.models).toEqual(["sd_xl_base_1.0.safetensors", "flux1-dev.safetensors"]);
		expect(out.detail).toContain("2 个 checkpoint");
	});

	it("Stability：没有模型清单接口，明确说明原因（models 为空数组）", async () => {
		const svc = normalizeService({ shape: "stability", baseUrl: "https://api.stability.ai" });
		const { fetch } = makeFetch([["/v1/user/account", () => jsonRes({ credits: 25 })]]);
		const out = await probeService(svc, { fetch });
		expect(out.ok).toBe(true);
		expect(out.models).toEqual([]);
		expect(out.detail).toContain("端点决定");
	});

	it("失败不抛错，回 ok:false + 原因（models 也是空数组）", async () => {
		const { fetch } = makeFetch([["/models", () => jsonRes({ error: { message: "no key" } }, 401)]]);
		const out = await probeService(AGY, { fetch });
		expect(out.ok).toBe(false);
		expect(out.detail).toContain("no key");
		expect(out.models).toEqual([]);
		const dead = await probeService(AGY, {
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as any,
		});
		expect(dead.ok).toBe(false);
		expect(dead.detail).toContain("ECONNREFUSED");
		expect(dead.models).toEqual([]);
	});
});
