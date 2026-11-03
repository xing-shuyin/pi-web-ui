/**
 * model-enrich 单测：规范化 / 模糊匹配 / 依据钉死 / URL 兜底。
 * 零网络（目录走注入 fixture，抓取走注入函数）。
 */
import { describe, expect, it } from "vitest";
import {
	buildIndex,
	enrichBatch,
	extractParamsFromHtml,
	normalizeModelId,
	parseModelsDevCatalog,
	parseOpenRouterCatalog,
	stripTierSuffix,
	type CatalogModel,
} from "../../server/model-enrich.js";

const OR_FIXTURE = {
	data: [
		{
			id: "anthropic/claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			context_length: 1000000,
			architecture: { input_modalities: ["text", "image"] },
			top_provider: { context_length: 1000000, max_completion_tokens: 128000 },
			supported_parameters: ["max_tokens", "temperature"],
		},
		{
			id: "google/gemini-3-pro",
			name: "Gemini 3 Pro",
			context_length: 1048576,
			architecture: { input_modalities: ["text"] },
			top_provider: { max_completion_tokens: 65536 },
			supported_parameters: [],
		},
		{
			id: "anthropic/claude-3-7-sonnet",
			name: "Claude 3.7 Sonnet",
			context_length: 200000,
			architecture: { input_modalities: ["text", "image"] },
			top_provider: { max_completion_tokens: 64000 },
			supported_parameters: ["max_tokens", "thinking"],
		},
		{
			id: "openai/o3-mini",
			name: "o3-mini",
			context_length: 200000,
			architecture: { input_modalities: ["text"] },
			top_provider: { max_completion_tokens: 100000 },
			supported_parameters: ["reasoning_effort"],
		},
	],
};

const MD_FIXTURE = {
	anthropic: {
		models: {
			"anthropic/claude-sonnet-4-5": {
				id: "anthropic/claude-sonnet-4-5",
				name: "Claude Sonnet 5",
				family: "claude-sonnet",
				reasoning: true,
				limit: { context: 1000000, output: 128000 },
				modalities: { input: ["text", "image"], output: ["text"] },
			},
		},
	},
	google: {
		models: {
			"google/gemini-3-pro": {
				id: "google/gemini-3-pro",
				name: "Gemini 3 Pro",
				family: "gemini-pro",
				reasoning: true,
				limit: { context: 1048576, output: 65536 },
				modalities: { input: ["text", "image"], output: ["text"] },
			},
		},
	},
};

function fixtures(): { openrouter: CatalogModel[]; modelsdev: CatalogModel[] } {
	return {
		openrouter: parseOpenRouterCatalog(OR_FIXTURE),
		modelsdev: parseModelsDevCatalog(MD_FIXTURE),
	};
}

describe("normalize / strip", () => {
	it("去前缀、小写、下划线", () => {
		expect(normalizeModelId("Anthropic/Claude-Sonnet-4-5")).toBe("claude-sonnet-4-5");
		expect(normalizeModelId("gemini_3_pro")).toBe("gemini-3-pro");
	});
	it("只剥路由档位与日期，不碰真实家族区分", () => {
		expect(stripTierSuffix("claude-sonnet-4-5-thinking")).toBe("claude-sonnet-4-5");
		expect(stripTierSuffix("gemini-3-pro-high")).toBe("gemini-3-pro");
		expect(stripTierSuffix("deepseek-v4-flash-0813")).toBe("deepseek-v4-flash");
		expect(stripTierSuffix("gemini-3-pro")).toBe("gemini-3-pro");
		expect(stripTierSuffix("gemini-3-flash")).toBe("gemini-3-flash");
		expect(stripTierSuffix("qwen3.8-max-preview")).toBe("qwen3.8");
	});
});

describe("enrichBatch 自动匹配", () => {
	it("别名回落 + 推理用 models.dev 补齐", async () => {
		const res = await enrichBatch(
			["claude-sonnet-4-5-thinking", "gemini-3-pro-high", "no-such-model"],
			{},
			{ catalogs: fixtures(), lang: "zh" },
		);
		const byId = new Map(res.map((r) => [r.id, r]));
		const claude = byId.get("claude-sonnet-4-5-thinking");
		expect(claude?.status).toBe("matched");
		expect(claude?.contextWindow).toBe(1000000);
		expect(claude?.maxTokens).toBe(128000);
		expect(claude?.input).toEqual(["text", "image"]);
		// OpenRouter fixture 无 reasoning 信号，models.dev 补上。
		expect(claude?.reasoning).toBe(true);
		expect(claude?.matchType).toBe("normalized");
		expect(claude?.source).toContain("OpenRouter");
		const gemini = byId.get("gemini-3-pro-high");
		expect(gemini?.status).toBe("matched");
		expect(gemini?.source).toContain("别名");
		const missing = byId.get("no-such-model");
		expect(missing?.status).toBe("unmatched");
	});
	it("en 默认来源标签无中文", async () => {
		const res = await enrichBatch(["gemini-3-pro-high"], {}, { catalogs: fixtures(), lang: "en" });
		expect(res[0].source).toContain("alias");
	});
});

describe("enrichBatch 依据钉死", () => {
	it("目录 id 钉死别名行", async () => {
		const res = await enrichBatch(
			["muse-spark"],
			{ "muse-spark": "anthropic/claude-sonnet-4-5" },
			{ catalogs: fixtures(), lang: "zh" },
		);
		expect(res[0].status).toBe("matched");
		expect(res[0].matchType).toBe("hint");
		expect(res[0].contextWindow).toBe(1000000);
	});
	it("依据未命中 → unmatched + note", async () => {
		const res = await enrichBatch(
			["muse-spark"],
			{ "muse-spark": "nope/nothing" },
			{ catalogs: fixtures(), lang: "en" },
		);
		expect(res[0].status).toBe("unmatched");
		expect(res[0].note).toContain("nope/nothing");
	});
	it("URL 依据走页面提取", async () => {
		const html = `<html><body><h1>Foo 1M context window, max output 128K tokens, image input supported</h1></body></html>`;
		const res = await enrichBatch(
			["foo-bar"],
			{ "foo-bar": "https://example.com/models/foo" },
			{ catalogs: fixtures(), lang: "en", pageFetch: async () => html },
		);
		expect(res[0].status).toBe("matched");
		expect(res[0].matchType).toBe("hint-url");
		expect(res[0].contextWindow).toBe(1000000);
		expect(res[0].maxTokens).toBe(128000);
		expect(res[0].input).toEqual(["text", "image"]);
		// 推理不从网页认。
		expect(res[0].reasoning).toBeUndefined();
	});
	it("URL 无可用参数 → unmatched", async () => {
		const res = await enrichBatch(
			["foo-bar"],
			{ "foo-bar": "https://example.com/hello" },
			{ catalogs: fixtures(), lang: "en", pageFetch: async () => "<html><body>hello</body></html>" },
		);
		expect(res[0].status).toBe("unmatched");
	});
});

describe("extractParamsFromHtml", () => {
	it("K/M 倍率与 script 剥离", () => {
		expect(extractParamsFromHtml("<script>context 999M</script><p>200K context</p>").contextWindow).toBe(200000);
		expect(extractParamsFromHtml("<p>1,048,576 tokens context window</p>").contextWindow).toBe(1048576);
		expect(extractParamsFromHtml("<p>离谱 999999999 tokens context</p>").contextWindow).toBeUndefined();
	});
});

describe("buildIndex 去重", () => {
	it("同 tail 多 provider 并存，exact 取首个", () => {
		const index = buildIndex([
			{ id: "a", provider: "p1", rawId: "p1/a", name: "A" },
			{ id: "a", provider: "p2", rawId: "p2/a", name: "A2" },
		]);
		expect(index.byId.get("a")?.length).toBe(2);
	});
});

describe("signal 中断与 onProgress 进度", () => {
	it("收到 onProgress 进度事件", async () => {
		const progressEvents: any[] = [];
		await enrichBatch(
			["claude-sonnet-4-5", "gemini-3-pro"],
			{},
			{
				catalogs: fixtures(),
				lang: "zh",
				onProgress: (p) => progressEvents.push(p),
			},
		);
		expect(progressEvents.length).toBeGreaterThanOrEqual(2);
		expect(progressEvents[0].phase).toBe("matching");
		expect(progressEvents[0].current).toBe(1);
		expect(progressEvents[0].total).toBe(2);
	});

	it("中途 abort 能中断并携带 partialResults", async () => {
		const ac = new AbortController();
		let callCount = 0;
		try {
			await enrichBatch(
				["claude-sonnet-4-5", "gemini-3-pro"],
				{},
				{
					catalogs: fixtures(),
					signal: ac.signal,
					onProgress: () => {
						callCount++;
						if (callCount === 2) {
							ac.abort();
						}
					},
				},
			);
			expect.unreachable("should have thrown aborted");
		} catch (err: any) {
			expect(err.message).toBe("aborted");
			expect(err.partialResults).toBeDefined();
			expect(err.partialResults.length).toBe(1);
			expect(err.partialResults[0].id).toBe("claude-sonnet-4-5");
		}
	});

	it("补参数时自动获取模型的权威思考强度配置（Token预算/档位/类型）", async () => {
		const res = await enrichBatch(
			["claude-3-7-sonnet", "o3-mini", "deepseek-r1"],
			{},
			{
				catalogs: fixtures(),
				lang: "zh",
			},
		);
		const claude = res.find((r) => r.id === "claude-3-7-sonnet");
		expect(claude?.reasoning).toBe(true);
		expect(claude?.reasoningType).toBe("budget");
		expect(claude?.thinkingLevelMap?.medium).toBe("8192");
		expect(claude?.thinkingLevelMap?.xhigh).toBe("32000");

		const o3 = res.find((r) => r.id === "o3-mini");
		expect(o3?.reasoning).toBe(true);
		expect(o3?.reasoningType).toBe("effort");
		expect(o3?.thinkingLevelMap?.high).toBe("high");

		const r1 = res.find((r) => r.id === "deepseek-r1");
		expect(r1?.reasoning).toBe(true);
		expect(r1?.reasoningType).toBe("fixed");
	});
});
