/**
 * model-resolver.test.ts — 通用模型解析器与跨引擎配置基础层单测。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	stripJsonComments,
	readModelsJson,
	readAuthJson,
	readProviderKeysJson,
	resolveProviderCredential,
	listCustomModelsFromConfig,
} from "../../server/model-resolver.js";
import { ClaudeCodeDriver } from "../../server/universal/drivers/claude-code.js";
import { ModelAdminService } from "../../server/model-admin.js";

describe("model-resolver", () => {
	let testAgentDir: string;

	beforeEach(() => {
		testAgentDir = mkdtempSync(join(tmpdir(), "pi-model-resolver-test-"));
	});

	afterEach(() => {
		try {
			rmSync(testAgentDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	describe("stripJsonComments", () => {
		it("剥离单行与多行注释，同时保留字符串字面量中的 URL //", () => {
			const json = `
			{
				// 这是单行注释
				"baseUrl": "https://api.anthropic.com/v1", /* 这是行内多行注释 */
				"models": [
					/*
					 多行注释块
					*/
					"claude-3-7-sonnet"
				]
			}
			`;
			const clean = stripJsonComments(json);
			const parsed = JSON.parse(clean);
			expect(parsed.baseUrl).toBe("https://api.anthropic.com/v1");
			expect(parsed.models).toEqual(["claude-3-7-sonnet"]);
		});

		it("容忍字符串内的转义引号", () => {
			const json = `{"quote": "Hello \\"World\\"", // comment\n "key": "val"}`;
			const clean = stripJsonComments(json);
			const parsed = JSON.parse(clean);
			expect(parsed.quote).toBe('Hello "World"');
			expect(parsed.key).toBe("val");
		});
	});

	describe("readModelsJson & readAuthJson & readProviderKeysJson", () => {
		it("当文件不存在时优雅返回空对象", () => {
			expect(readModelsJson(testAgentDir)).toEqual({ providers: {} });
			expect(readAuthJson(testAgentDir)).toEqual({});
			expect(readProviderKeysJson(testAgentDir)).toEqual({});
		});

		it("正确读取并解析带注释的 models.json", () => {
			const content = `{
				// 配置自定义代理
				"providers": {
					"my-proxy": {
						"baseUrl": "https://proxy.example.com",
						"apiKey": "sk-proxy-123",
						"api": "anthropic-messages",
						"models": [
							{ "id": "claude-3-7-sonnet", "name": "Claude 3.7 (Proxy)" }
						]
					}
				}
			}`;
			writeFileSync(join(testAgentDir, "models.json"), content, "utf8");
			const res = readModelsJson(testAgentDir);
			expect(res.providers["my-proxy"]).toBeDefined();
			expect(res.providers["my-proxy"].baseUrl).toBe("https://proxy.example.com");
		});
	});

	describe("resolveProviderCredential", () => {
		it("优先级 1：优先采用 models.json 中的 apiKey 与 baseUrl", () => {
			writeFileSync(
				join(testAgentDir, "models.json"),
				JSON.stringify({
					providers: {
						"custom-claude": {
							baseUrl: "https://my-proxy.com/anthropic",
							apiKey: "sk-models-json-key",
						},
					},
				}),
				"utf8",
			);
			writeFileSync(
				join(testAgentDir, "auth.json"),
				JSON.stringify({
					"custom-claude": { type: "api_key", key: "sk-auth-json-key" },
				}),
				"utf8",
			);

			const cred = resolveProviderCredential(testAgentDir, "custom-claude");
			expect(cred.baseUrl).toBe("https://my-proxy.com/anthropic");
			expect(cred.apiKey).toBe("sk-models-json-key");
		});

		it("优先级 2：若 models.json 无 apiKey，回落到 provider-keys.json 激活密钥", () => {
			writeFileSync(
				join(testAgentDir, "models.json"),
				JSON.stringify({
					providers: {
						anthropic: {
							baseUrl: "https://custom.anthropic.com",
						},
					},
				}),
				"utf8",
			);
			writeFileSync(
				join(testAgentDir, "provider-keys.json"),
				JSON.stringify({
					anthropic: {
						activeKeyName: "第二把钥匙",
						keys: [
							{ name: "默认", apiKey: "sk-key-1" },
							{ name: "第二把钥匙", apiKey: "sk-key-2" },
						],
					},
				}),
				"utf8",
			);

			const cred = resolveProviderCredential(testAgentDir, "anthropic");
			expect(cred.baseUrl).toBe("https://custom.anthropic.com");
			expect(cred.apiKey).toBe("sk-key-2");
		});

		it("优先级 3：若无多密钥，回落到 auth.json", () => {
			writeFileSync(
				join(testAgentDir, "auth.json"),
				JSON.stringify({
					anthropic: { type: "api_key", key: "sk-ant-from-auth" },
					deepseek: { type: "api_key", key: "sk-ds-from-auth" },
				}),
				"utf8",
			);

			const antCred = resolveProviderCredential(testAgentDir, "anthropic");
			expect(antCred.apiKey).toBe("sk-ant-from-auth");

			const dsCred = resolveProviderCredential(testAgentDir, "deepseek");
			expect(dsCred.apiKey).toBe("sk-ds-from-auth");
		});

		it("优先级 4：环境变量兜底", () => {
			const prevEnv = process.env.ANTHROPIC_API_KEY;
			const prevBase = process.env.ANTHROPIC_BASE_URL;
			try {
				process.env.ANTHROPIC_API_KEY = "sk-env-ant-key";
				process.env.ANTHROPIC_BASE_URL = "https://env.anthropic.com";

				const cred = resolveProviderCredential(testAgentDir, "anthropic");
				expect(cred.apiKey).toBe("sk-env-ant-key");
				expect(cred.baseUrl).toBe("https://env.anthropic.com");
			} finally {
				if (prevEnv !== undefined) process.env.ANTHROPIC_API_KEY = prevEnv;
				else delete process.env.ANTHROPIC_API_KEY;
				if (prevBase !== undefined) process.env.ANTHROPIC_BASE_URL = prevBase;
				else delete process.env.ANTHROPIC_BASE_URL;
			}
		});
	});

	describe("listCustomModelsFromConfig", () => {
		it("列出 models.json 中定义的全部自定义模型条目", () => {
			writeFileSync(
				join(testAgentDir, "models.json"),
				JSON.stringify({
					providers: {
						"one-api": {
							name: "聚合网关",
							api: "anthropic-messages",
							models: [
								{ id: "claude-3-7-sonnet", name: "Sonnet 3.7 网关版" },
								{ id: "claude-3-5-haiku", name: "Haiku 3.5 网关版" },
							],
						},
					},
				}),
				"utf8",
			);

			const models = listCustomModelsFromConfig(testAgentDir);
			expect(models.length).toBe(2);
			expect(models[0]).toMatchObject({
				providerId: "one-api",
				providerName: "聚合网关",
				modelId: "claude-3-7-sonnet",
				name: "Sonnet 3.7 网关版",
			});
		});
	});

	describe("ClaudeCodeDriver 动态扩展模型与凭据桥接", () => {
		it("自动合并官方模型与 models.json 中的自定义代理模型", async () => {
			writeFileSync(
				join(testAgentDir, "models.json"),
				JSON.stringify({
					providers: {
						ccproxy: {
							name: "CC 代理站",
							baseUrl: "https://proxy.example.com",
							apiKey: "sk-proxy-test",
							models: [{ id: "claude-3-7-sonnet", name: "Sonnet 3.7" }],
						},
					},
				}),
				"utf8",
			);

			const driver = new ClaudeCodeDriver(process.cwd(), {
				agentDir: testAgentDir,
			});

			const models = await driver.listModels();
			// 4 个官方内置 + 1 个自定义
			expect(models.length).toBe(5);
			expect(models.some((m) => m.id === "ccproxy/claude-3-7-sonnet")).toBe(true);
			expect(models.find((m) => m.id === "ccproxy/claude-3-7-sonnet")?.name).toBe("Sonnet 3.7");
		});
	});

	describe("ModelAdminService 无 modelRuntime 运行兼容性", () => {
		it("在非 Pi 引擎下正常枚举服务商状态与配置", async () => {
			writeFileSync(
				join(testAgentDir, "auth.json"),
				JSON.stringify({
					anthropic: { type: "api_key", key: "sk-ant-test" },
				}),
				"utf8",
			);

			let receivedProviders: any[] = [];
			const admin = new ModelAdminService({
				agentDir: testAgentDir,
				emit: (msg) => {
					if (msg.type === "providers_status") {
						receivedProviders = msg.providers;
					}
				},
				flushSnapshot: () => {},
				isDisposed: () => false,
				pushModels: async () => {},
			});

			await admin.listProviders();
			expect(receivedProviders.length).toBeGreaterThan(0);
			const ant = receivedProviders.find((p) => p.id === "anthropic");
			expect(ant).toBeDefined();
			expect(ant?.configured).toBe(true);
			expect(ant?.source).toBe("stored");

			admin.dispose();
		});
	});
});
