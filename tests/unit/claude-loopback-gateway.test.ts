/**
 * Claude Code 引擎 × 本机回环网关（Magpie / one-api 等单端口协议转换）的端到端回归：
 * 模型列表要收进回环网关的 OpenAI 协议条目，但 spawn 出去的 ANTHROPIC_BASE_URL 必须
 * 是 Anthropic 端点的根（剥掉 `/v1`），否则 CLI 拼出 `/v1/v1/messages` 直接 404。
 *
 * 纯函数用例在 model-protocol-filter.test.ts；这里锁住真正出问题的两个接线点：
 * `listModels()` 的过滤 与 `buildSpawnEnv()` 的基地址换算。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeDriver } from "../../server/universal/drivers/claude-code.js";
import { isModelProtocolSupportedByEngine } from "../../server/model-resolver.js";

describe("Claude Code × 本机回环网关", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-claude-loopback-gateway-"));
	});

	afterEach(() => {
		try {
			rmSync(agentDir, { recursive: true, force: true });
		} catch {}
	});

	function writeProviders(providers: Record<string, unknown>): void {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }), "utf8");
	}

	it("回环网关的 OpenAI 协议模型进模型列表，远程同类条目不进", async () => {
		writeProviders({
			magpie: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:3425/v1",
				apiKey: "local-key",
				models: [{ id: "gpt-5-codex", name: "GPT-5 Codex (Magpie)" }],
			},
			remote: {
				api: "openai-completions",
				baseUrl: "https://api.example.com/v1",
				apiKey: "remote-key",
				models: [{ id: "remote-model", name: "Remote" }],
			},
		});

		const driver = new ClaudeCodeDriver(process.cwd(), { agentDir });
		const ids = (await driver.listModels()).map((m) => m.id);

		expect(ids).toContain("magpie/gpt-5-codex");
		// 远程地址不做协议转换假设：仍严格只认 anthropic-messages
		expect(ids).not.toContain("remote/remote-model");

		driver.dispose();
	});

	it("网关条目的 ANTHROPIC_BASE_URL 剥掉尾部 /v1，原生 anthropic 基地址原样透传", () => {
		writeProviders({
			magpie: { api: "openai-completions", baseUrl: "http://127.0.0.1:3425/v1", apiKey: "local-key" },
			anthropic: { api: "anthropic-messages", baseUrl: "https://proxy.example.com/anthropic", apiKey: "sk-x" },
		});

		const driver = new ClaudeCodeDriver(process.cwd(), { agentDir });

		expect(driver.buildSpawnEnv(false, "magpie").ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3425");
		expect(driver.buildSpawnEnv(false, "anthropic").ANTHROPIC_BASE_URL).toBe("https://proxy.example.com/anthropic");
		expect(driver.buildSpawnEnv(true, null).ANTHROPIC_BASE_URL).toBeUndefined();

		driver.dispose();
	});

	it("本机 ollama / bedrock 条目没有 Anthropic 端点，即使回环也不放行", () => {
		expect(
			isModelProtocolSupportedByEngine(
				"claude-gateway",
				{ api: "ollama", providerId: "ollama", baseUrl: "http://127.0.0.1:11434" },
				"http://127.0.0.1:11434",
			),
		).toBe(false);
		expect(
			isModelProtocolSupportedByEngine(
				"claude-gateway",
				{ api: "bedrock", providerId: "bedrock", baseUrl: "http://127.0.0.1:9000" },
				"http://127.0.0.1:9000",
			),
		).toBe(false);
	});
});
