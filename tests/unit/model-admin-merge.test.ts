import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ModelAdminService, mergeProviderConfigEntry, type ModelAdminHost } from "../../server/model-admin.js";
import type { ServerMessage, UiModelConfigEntry, UiProviderConfig } from "../../server/protocol.js";

function formModel(id: string, overrides: Partial<UiModelConfigEntry> = {}): UiModelConfigEntry {
	return { id, ...overrides };
}

function formConfig(models: UiModelConfigEntry[], overrides: Partial<UiProviderConfig> = {}): UiProviderConfig {
	return { providerId: "opencode-go", api: "openai-completions", models, ...overrides };
}

const storedOverrideEntry = {
	api: "openai-completions",
	baseUrl: "https://opencode.ai/zen/go/v1",
	headers: { "X-Test": "1" },
	models: [
		{
			id: "deepseek-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/go/v1",
			cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
			compat: { thinkingFormat: "deepseek" },
			thinkingLevelMap: { low: "low", high: "high" },
			contextWindow: 1000000,
			maxTokens: 384000,
		},
	],
};

describe("mergeProviderConfigEntry", () => {
	it("没有旧条目时，产出与旧实现一致的条目形状", () => {
		const rows = [
			formModel("m1", { name: "M1", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100 }),
		];
		const merged = mergeProviderConfigEntry(undefined, formConfig(rows, { baseUrl: "https://example.test/v1" }), rows);
		expect(merged).toEqual({
			api: "openai-completions",
			baseUrl: "https://example.test/v1",
			models: [{ id: "m1", name: "M1", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100 }],
		});
	});

	it("provider 级未知字段原样保留（headers 及任意自定义键）", () => {
		const prev = {
			apiKey: "stored",
			headers: { Authorization: "Bearer secret" },
			extraField: { nested: true },
			models: [{ id: "m1" }],
		};
		const merged = mergeProviderConfigEntry(prev, formConfig([formModel("m1")]), [formModel("m1")]);
		expect(merged.headers).toEqual({ Authorization: "Bearer secret" });
		expect(merged.extraField).toEqual({ nested: true });
		expect(merged.apiKey).toBe("stored");
	});

	it("apiKey：缺字段 = 保留旧值，显式空串 = 清除，非空 = 覆盖", () => {
		const prev = { apiKey: "stored", models: [{ id: "m1" }] };

		expect(mergeProviderConfigEntry(prev, formConfig([formModel("m1")]), [formModel("m1")]).apiKey).toBe("stored");

		const cleared = mergeProviderConfigEntry(prev, formConfig([formModel("m1")], { apiKey: "  " }), [formModel("m1")]);
		expect("apiKey" in cleared).toBe(false);

		const replaced = mergeProviderConfigEntry(prev, formConfig([formModel("m1")], { apiKey: " new-key " }), [
			formModel("m1"),
		]);
		expect(replaced.apiKey).toBe("new-key");
	});

	it("模型级未知字段原样保留（覆盖内置 provider 的场景）", () => {
		const rows = [
			formModel("deepseek-flash", {
				name: "DeepSeek V4.1 Flash",
				reasoning: true,
				contextWindow: 1000000,
				maxTokens: 384000,
			}),
		];
		const merged = mergeProviderConfigEntry(storedOverrideEntry, formConfig(rows), rows);
		expect(merged.models).toEqual([{ ...storedOverrideEntry.models[0], reasoning: true }]);
	});

	it("表单字段覆盖旧值（含数字字段归一）", () => {
		const prev = {
			name: "旧名字",
			baseUrl: "https://old.test/v1",
			models: [{ id: "m1", name: "旧模型名", contextWindow: 1000, maxTokens: 10, cost: { input: 1 } }],
		};
		const rows = [formModel("m1", { name: "新模型名", contextWindow: 2000, maxTokens: 20 })];
		const merged = mergeProviderConfigEntry(
			prev,
			formConfig(rows, { name: "新名字", baseUrl: "https://new.test/v1" }),
			rows,
		);
		expect(merged.name).toBe("新名字");
		expect(merged.baseUrl).toBe("https://new.test/v1");
		expect(merged.models).toEqual([
			{ id: "m1", name: "新模型名", contextWindow: 2000, maxTokens: 20, cost: { input: 1 } },
		]);
	});

	it("表单清空的可选字段被删除，不残留旧值", () => {
		const prev = {
			models: [
				{
					id: "m1",
					name: "旧模型名",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 1000,
					maxTokens: 100,
					compat: { thinkingFormat: "deepseek" },
				},
			],
		};
		const merged = mergeProviderConfigEntry(prev, formConfig([formModel("m1")]), [formModel("m1")]);
		expect(merged.models).toEqual([{ id: "m1", compat: { thinkingFormat: "deepseek" } }]);
	});

	it("models 是「表单即全集」：删掉的 id 移除，新 id 追加", () => {
		const prev = {
			models: [
				{ id: "keep", cost: { input: 1 } },
				{ id: "drop", cost: { input: 2 } },
			],
		};
		const rows = [formModel("keep"), formModel("added", { reasoning: true })];
		const merged = mergeProviderConfigEntry(prev, formConfig(rows), rows);
		expect(merged.models).toEqual([
			{ id: "keep", cost: { input: 1 } },
			{ id: "added", reasoning: true },
		]);
	});

	it("容忍旧条目里的脏数据（非对象 / 缺 id / 空白 id）", () => {
		const prev = { models: [null, "oops", { name: "无 id" }, { id: "   " }, { id: "ok" }] };
		const rows = [formModel("ok", { name: "OK" })];
		const merged = mergeProviderConfigEntry(prev, formConfig(rows), rows);
		expect(merged.models).toEqual([{ id: "ok", name: "OK" }]);
	});
});

describe("ModelAdminService.saveModelConfig", () => {
	it("保存后 models.json 里 UI 不认识的字段仍在（旧实现会静默丢弃）", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-model-admin-"));
		const configPath = join(agentDir, "models.json");
		writeFileSync(configPath, JSON.stringify({ providers: { "opencode-go": storedOverrideEntry } }, null, 2) + "\n");

		const notices: ServerMessage[] = [];
		const host = {
			agentDir,
			emit: (msg: ServerMessage) => {
				notices.push(msg);
			},
			flushSnapshot: () => {},
			isDisposed: () => false,
			modelRuntime: () => ({ refresh: async () => {}, setRuntimeApiKey: async () => {} }) as unknown as ModelRuntime,
			invalidatePiConfig: () => {},
			pushModels: async () => {},
		} satisfies ModelAdminHost;

		try {
			const service = new ModelAdminService(host);
			const rows = [
				formModel("deepseek-flash", {
					name: "DeepSeek V4.1 Flash",
					reasoning: true,
					contextWindow: 1000000,
					maxTokens: 384000,
				}),
			];
			await service.saveModelConfig("opencode-go", formConfig(rows));

			const written = JSON.parse(readFileSync(configPath, "utf8")) as {
				providers: Record<string, Record<string, unknown>>;
			};
			const entry = written.providers["opencode-go"];
			expect(entry.headers).toEqual({ "X-Test": "1" });
			expect(entry.models).toEqual([{ ...storedOverrideEntry.models[0], reasoning: true }]);
			expect(notices.some((msg) => msg.type === "notice")).toBe(true);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
