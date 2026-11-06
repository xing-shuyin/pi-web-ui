import { describe, expect, it } from "vitest";
import { graduateOverlayModels } from "../../server/model-admin.js";

const official = {
	opencode: { "union-alpha-free": "openai-completions", "kimi-k2.6": "anthropic-messages" },
} as Record<string, Record<string, string | undefined>>;

describe("graduateOverlayModels", () => {
	it("裸 id 行在官方收录后被移除", () => {
		const providers = {
			opencode: { models: [{ id: "union-alpha-free" }, { id: "my-local" }] },
		} as Record<string, Record<string, unknown>>;
		const graduated = graduateOverlayModels(providers, official);
		expect(graduated).toEqual([{ providerId: "opencode", modelId: "union-alpha-free" }]);
		expect(providers.opencode.models).toEqual([{ id: "my-local" }]);
	});

	it("显式 api 与官方一致的行也转正（只缺元数据）", () => {
		const providers = {
			opencode: { models: [{ id: "union-alpha-free", api: "openai-completions" }] },
		} as unknown as Record<string, Record<string, unknown>>;
		expect(graduateOverlayModels(providers, official)).toEqual([
			{ providerId: "opencode", modelId: "union-alpha-free" },
		]);
		expect(providers).not.toHaveProperty("opencode");
	});

	it("自带 baseUrl 的行是刻意定制，不转正", () => {
		const providers = {
			opencode: {
				models: [
					{ id: "union-alpha-free", baseUrl: "https://proxy.local/v1" },
					{ id: "union-alpha-free", api: "openai-completions", baseUrl: "https://proxy.local/v1" },
				],
			},
		} as unknown as Record<string, Record<string, unknown>>;
		expect(graduateOverlayModels(providers, official)).toEqual([]);
		expect((providers.opencode.models as unknown[]).length).toBe(2);
	});

	it("异种 api 的行是刻意定制，不转正", () => {
		const providers = {
			opencode: { models: [{ id: "union-alpha-free", api: "anthropic-messages" }] },
		} as unknown as Record<string, Record<string, unknown>>;
		expect(graduateOverlayModels(providers, official)).toEqual([]);
		expect(providers.opencode.models).toEqual([{ id: "union-alpha-free", api: "anthropic-messages" }]);
	});

	it("官方 api 未知时只转裸行", () => {
		const providers = {
			opencode: {
				models: [{ id: "mystery-model" }, { id: "mystery-model-2", api: "openai-completions" }],
			},
		} as unknown as Record<string, Record<string, unknown>>;
		const officialUnknown = { opencode: { "mystery-model": undefined, "mystery-model-2": undefined } } as Record<
			string,
			Record<string, string | undefined>
		>;
		expect(graduateOverlayModels(providers, officialUnknown)).toEqual([
			{ providerId: "opencode", modelId: "mystery-model" },
		]);
		expect(providers.opencode.models).toEqual([{ id: "mystery-model-2", api: "openai-completions" }]);
	});

	it("转空且无其他 key 的条目整体删除（退出自定义列表）", () => {
		const providers = { opencode: { models: [{ id: "union-alpha-free" }] } } as Record<string, Record<string, unknown>>;
		expect(graduateOverlayModels(providers, official)).toEqual([
			{ providerId: "opencode", modelId: "union-alpha-free" },
		]);
		expect(providers).not.toHaveProperty("opencode");
	});

	it("转空但带其他 key 的条目保留（只清 models）", () => {
		const providers = {
			opencode: { apiKey: "sk-xxx", models: [{ id: "union-alpha-free" }] },
		} as Record<string, Record<string, unknown>>;
		expect(graduateOverlayModels(providers, official)).toEqual([
			{ providerId: "opencode", modelId: "union-alpha-free" },
		]);
		expect(providers.opencode).toEqual({ apiKey: "sk-xxx", models: [] });
	});

	it("官方没有的 id / 没有官方数据的供应商不动", () => {
		const providers = {
			opencode: { models: [{ id: "future-model" }] },
			other: { models: [{ id: "union-alpha-free" }] },
		} as Record<string, Record<string, unknown>>;
		expect(graduateOverlayModels(providers, official)).toEqual([]);
		expect(providers.opencode.models).toEqual([{ id: "future-model" }]);
		expect(providers.other.models).toEqual([{ id: "union-alpha-free" }]);
	});

	it("脏数据不抛错（models 非数组 / 行无 id）", () => {
		const providers = {
			broken: { models: "nope" },
			messy: { models: [null, 42, { id: 7 }, { id: "  " }] },
		} as unknown as Record<string, Record<string, unknown>>;
		const dirty = { broken: { x: "openai-completions" }, messy: { x: "openai-completions" } } as Record<
			string,
			Record<string, string | undefined>
		>;
		expect(() => graduateOverlayModels(providers, dirty)).not.toThrow();
		expect(graduateOverlayModels(providers, dirty)).toEqual([]);
	});
});
