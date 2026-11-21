import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TRANSLATE_ENGINE,
	DEFAULT_TRANSLATE_TARGET,
	TENCENT_MAX_CHARS,
	googleBody,
	googleEndpoint,
	normalizeTranslateEngine,
	normalizeTranslateTarget,
	parseGoogleResponse,
	parseTencentResponse,
	parseTranslateBridgeRequest,
	tencentBody,
	tencentChunks,
	tencentPieces,
	translateTexts,
} from "../../browser/runtime/translate-engines.js";

/**
 * 网页翻译现在走腾讯 / Google 两个免费引擎（AI 翻译、微软 Edge 匿名端点都已下线）。
 * 这里钉住三件事：请求前校验、语言映射与切块、响应解析——厂商协议一变就得在这里先红。
 */

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** 腾讯成功响应：`auto_translation` 与请求顺序一一对应。 */
const tencentOk = (translations: string[]) => json({ header: { ret_code: "succ" }, auto_translation: translations });

const TENCENT_URL = "transmart.qq.com";
const GOOGLE_URL = "translate.googleapis.com";

describe("页面桥的请求校验", () => {
	it("只收非空文本，超条数/超长度直接拒绝", () => {
		expect(parseTranslateBridgeRequest({ texts: ["a"] }, "zh-CN")).toEqual({ texts: ["a"], target: "zh-CN" });
		expect(() => parseTranslateBridgeRequest({ texts: [] }, "zh-CN")).toThrow();
		expect(() => parseTranslateBridgeRequest({ texts: ["  "] }, "zh-CN")).toThrow();
		expect(() => parseTranslateBridgeRequest({ texts: ["x".repeat(12_001)] }, "zh-CN")).toThrow();
		expect(() => parseTranslateBridgeRequest({ texts: Array(121).fill("a") }, "zh-CN")).toThrow();
		// 总量上限（24k）也要卡：三段各自合法，加起来超了
		expect(() =>
			parseTranslateBridgeRequest({ texts: ["x".repeat(12_000), "y".repeat(12_000), "z".repeat(1)] }, "zh-CN"),
		).toThrow();
	});

	it("target=auto / 缺省落到设置里的目标语言，白名单外的目标语言拒绝", () => {
		expect(parseTranslateBridgeRequest({ texts: ["a"], target: "auto" }, "ja").target).toBe("ja");
		expect(parseTranslateBridgeRequest({ texts: ["a"] }, "en").target).toBe("en");
		expect(parseTranslateBridgeRequest({ texts: ["a"], target: "fr" }, "en").target).toBe("fr");
		expect(() => parseTranslateBridgeRequest({ texts: ["a"], target: "xx" }, "en")).toThrow();
	});

	it("设置值非法时退回默认引擎与默认目标语言", () => {
		expect(normalizeTranslateEngine("google")).toBe("google");
		expect(normalizeTranslateEngine("tencent")).toBe("tencent");
		expect(normalizeTranslateEngine("ai")).toBe(DEFAULT_TRANSLATE_ENGINE);
		expect(normalizeTranslateTarget("zh-TW")).toBe("zh-TW");
		expect(normalizeTranslateTarget(undefined)).toBe(DEFAULT_TRANSLATE_TARGET);
	});

	it("旧设置里的 edge 静默迁到当前默认引擎（该端点已下线，不留在设置面板里）", () => {
		expect(normalizeTranslateEngine("edge")).toBe(DEFAULT_TRANSLATE_ENGINE);
		expect(normalizeTranslateEngine("edge")).not.toBe("edge");
	});
});

describe("端点与语言映射", () => {
	it("腾讯把中文拆成 zh / zh-TW，其余沿用 BCP-47 前缀", () => {
		const body = (target: Parameters<typeof tencentBody>[1]) => JSON.parse(tencentBody(["hi"], target));
		expect(body("zh-CN").target.lang).toBe("zh");
		expect(body("zh-TW").target.lang).toBe("zh-TW");
		expect(body("ja").target.lang).toBe("ja");
		expect(body("tr").target.lang).toBe("tr");
		// 源语言交给引擎自己判断，页面无权指定
		expect(body("zh-CN").source.lang).toBe("auto");
		expect(body("zh-CN").source.text_list).toEqual(["hi"]);
	});

	it("Google 把待译文本放进 POST 表单 body，目标语言放进 tl", () => {
		const url = new URL(googleEndpoint("zh-CN"));
		expect(url.searchParams.get("tl")).toBe("zh-CN");
		expect(url.searchParams.get("client")).toBe("gtx");
		expect(url.searchParams.get("q")).toBeNull();
		expect(googleBody("hello world & co")).toBe("q=hello%20world%20%26%20co");
	});
});

describe("腾讯的切块（整批超限 = 所有条一起失败，必须先切）", () => {
	it("短文本一条一片，累计到上限就换块", () => {
		const texts = Array(4).fill("x".repeat(2_000));
		const pieces = tencentPieces(texts);
		expect(pieces.map((piece) => piece.index)).toEqual([0, 1, 2, 3]);
		// 2000+2000 到 4000，再加一条就超 5000 → 两块
		expect(tencentChunks(pieces)).toEqual([
			[0, 1],
			[2, 3],
		]);
	});

	it("单条超上限时按句子边界切开，并按顺序摊平成片", () => {
		const sentence = "This is a sentence. ";
		const long = sentence.repeat(Math.ceil((TENCENT_MAX_CHARS * 2) / sentence.length));
		const pieces = tencentPieces([long]);
		expect(pieces.length).toBeGreaterThan(1);
		expect(pieces.every((piece) => piece.index === 0)).toBe(true);
		expect(pieces.every((piece) => piece.text.length <= TENCENT_MAX_CHARS)).toBe(true);
		// 切点落在句号后，不把词劈成两半
		expect(pieces.slice(0, -1).every((piece) => piece.text.trimEnd().endsWith("."))).toBe(true);
		expect(pieces.map((piece) => piece.text).join("")).toContain("This is a sentence.");
	});

	it("片数上限也参与切块（一条都不许丢）", () => {
		const pieces = tencentPieces(Array(120).fill("word"));
		expect(tencentChunks(pieces).flat()).toHaveLength(120);
		expect(tencentChunks(pieces).every((chunk) => chunk.length <= 120)).toBe(true);
	});
});

describe("响应解析", () => {
	it("腾讯：ret_code 非 succ 就是失败，条数对不上也是协议变了", () => {
		expect(parseTencentResponse({ header: { ret_code: "succ" }, auto_translation: ["你好", "世界"] }, 2)).toEqual([
			"你好",
			"世界",
		]);
		expect(() => parseTencentResponse({ header: { ret_code: "outOfLimit" }, message: "limit" }, 1)).toThrow(
			/outOfLimit/,
		);
		expect(() => parseTencentResponse({ header: { ret_code: "succ" }, auto_translation: ["a"] }, 2)).toThrow();
		expect(() => parseTencentResponse({ auto_translation: ["a"] }, 1)).toThrow();
		expect(() => parseTencentResponse({ header: { ret_code: "succ" }, auto_translation: [1] }, 1)).toThrow();
	});

	it("Google：多段句子的译文按顺序拼起来", () => {
		expect(
			parseGoogleResponse([
				[
					["你好", "hello"],
					["世界", "world"],
				],
				null,
				"en",
			]),
		).toBe("你好世界");
		expect(() => parseGoogleResponse([[]])).toThrow();
		expect(() => parseGoogleResponse(null)).toThrow();
	});
});

describe("整批翻译", () => {
	it("腾讯：一次批量 POST，译文按原顺序回位", async () => {
		const bodies: unknown[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toContain(TENCENT_URL);
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
			return tencentOk(body.source.text_list.map((text: string) => `译:${text}`));
		});
		const result = await translateTexts(
			{ texts: ["hello", "world"], engine: "tencent", target: "zh-CN" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result.translations).toEqual(["译:hello", "译:world"]);
		expect(result.model).toBe("腾讯翻译");
		expect(bodies).toHaveLength(1);
	});

	it("腾讯：超上限时切成多个请求，译文回到各自的下标", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			return tencentOk(body.source.text_list.map((text: string) => text.toUpperCase()));
		});
		const texts = ["a".repeat(3_000), "b".repeat(3_000), "c".repeat(3_000)];
		const result = await translateTexts(
			{ texts, engine: "tencent", target: "ja" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result.translations).toEqual(texts.map((text) => text.toUpperCase()));
		// 3000+3000 超 5000 → 至少两块，且每条请求都没超上限
		expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
	});

	it("腾讯：单条超长被切开后按顺序拼回一条", async () => {
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			return tencentOk(body.source.text_list.map((text: string) => `<${text}>`));
		});
		const long = "Sentence here. ".repeat(1_000);
		const result = await translateTexts(
			{ texts: [long], engine: "tencent", target: "zh-CN" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result.translations).toHaveLength(1);
		expect(result.translations[0].startsWith("<Sentence here.")).toBe(true);
		expect(result.translations[0].endsWith(">")).toBe(true);
	});

	it("Google：逐段 POST，译文按原顺序回位", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toContain(GOOGLE_URL);
			expect(String(input)).toContain("dt=t");
			const text = decodeURIComponent(String(init?.body).replace(/^q=/, ""));
			return json([[[`译:${text}`, text]]]);
		});
		const result = await translateTexts(
			{ texts: ["a", "b", "c"], engine: "google", target: "ja" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result.translations).toEqual(["译:a", "译:b", "译:c"]);
		expect(result.model).toBe("Google 翻译");
	});

	it("主引擎失败时自动换另一个引擎，model 报实际生效的那个", async () => {
		const seen: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			seen.push(url);
			if (url.includes(TENCENT_URL)) return json({ header: { ret_code: "error" }, message: "boom" });
			return json([[["你好", "hello"]]]);
		});
		const result = await translateTexts(
			{ texts: ["hello"], engine: "tencent", target: "zh-CN" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(result.translations).toEqual(["你好"]);
		expect(result.model).toBe("Google 翻译");
		expect(seen[0]).toContain(TENCENT_URL);
		expect(seen[1]).toContain(GOOGLE_URL);
	});

	it("两个引擎都失败才整批抛错（调用方留原文，不写半截译文）", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) =>
			String(input).includes(TENCENT_URL) ? json({ header: { ret_code: "error" } }) : json({}, 503),
		);
		await expect(
			translateTexts(
				{ texts: ["hello"], engine: "tencent", target: "zh-CN" },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toThrow();
	});

	it("关掉回退时只试设置里的引擎（单测其它引擎行为用）", async () => {
		const fetchMock = vi.fn(async () => json({}, 503));
		await expect(
			translateTexts(
				{ texts: ["hello"], engine: "tencent", target: "zh-CN" },
				{ fetch: fetchMock as unknown as typeof fetch, fallback: false },
			),
		).rejects.toThrow(/503/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
