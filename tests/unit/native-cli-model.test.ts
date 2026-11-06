import { describe, expect, it, vi } from "vitest";
import { nativeCliModelLaunch, resolveNativeCliModelConnection } from "../../server/native-cli-model.js";
import type { NativeCliConfig } from "../../server/protocol.js";

const config = (preset: "claude" | "codex" = "claude"): NativeCliConfig => ({
	preset,
	model: { provider: "configured-provider", id: "configured-model" },
});

function runtime() {
	return {
		getModel: vi.fn(() => ({
			provider: "configured-provider",
			id: "configured-model",
			api: "anthropic-messages",
			baseUrl: "https://configured.test",
		})),
		isUsingOAuth: vi.fn(() => false),
		getAuth: vi.fn(async () => ({
			auth: { apiKey: "resolved-test-key", baseUrl: "https://resolved.test", headers: { "X-Auth": "auth-header" } },
		})),
		getCompatibilityRequestConfig: vi.fn(() => ({
			headers: { "X-Configured": "configured-header", "X-Removed": null },
		})),
	} as any;
}

describe("native CLI model connection", () => {
	it("uses the SDK's current auth, base URL and configured headers", async () => {
		const models = runtime();
		expect(await resolveNativeCliModelConnection(config(), models)).toEqual({
			baseUrl: "https://resolved.test",
			apiKey: "resolved-test-key",
			headers: { "X-Configured": "configured-header", "X-Auth": "auth-header" },
		});
		expect(models.getModel).toHaveBeenCalledWith("configured-provider", "configured-model");
		expect(models.getAuth).toHaveBeenCalledWith(models.getModel.mock.results[0].value);
	});

	it("uses the model endpoint when auth only supplies a key", async () => {
		const models = runtime();
		models.getAuth.mockResolvedValue({ auth: { apiKey: "test-key" } });
		expect(await resolveNativeCliModelConnection(config(), models)).toMatchObject({
			baseUrl: "https://configured.test",
		});
	});

	it("does not resolve credentials when inheritance is disabled or the CLI owns authentication", async () => {
		const models = runtime();
		expect(await resolveNativeCliModelConnection({ preset: "claude" }, models)).toBeUndefined();
		expect(await resolveNativeCliModelConnection({ ...config(), preset: "agy" }, models)).toBeUndefined();
		expect(await resolveNativeCliModelConnection({ ...config(), preset: "pi" }, models)).toBeUndefined();
		expect(models.getModel).not.toHaveBeenCalled();
		models.isUsingOAuth.mockReturnValue(true);
		expect(await resolveNativeCliModelConnection(config(), models)).toBeUndefined();
		expect(models.getAuth).not.toHaveBeenCalled();
	});

	it("leaves the CLI login available when no API credentials are configured", async () => {
		const models = runtime();
		models.getAuth.mockResolvedValue(undefined);
		expect(await resolveNativeCliModelConnection(config(), models)).toBeUndefined();
	});

	it("reports missing or incompatible captured models before starting a CLI", async () => {
		const models = runtime();
		models.getModel.mockReturnValueOnce(undefined);
		await expect(resolveNativeCliModelConnection(config(), models)).rejects.toThrow("unavailable");
		models.getModel.mockReturnValueOnce({ provider: "configured-provider", api: "openai-responses" });
		await expect(resolveNativeCliModelConnection(config(), models)).rejects.toThrow("protocol");
		expect(models.getAuth).not.toHaveBeenCalled();
	});
});

describe("per-process native CLI provider settings", () => {
	const connection = {
		baseUrl: "https://configured.test/api",
		apiKey: "private-test-key",
		headers: { "X-Provider-Token": "private-header-value" },
	};

	it("gives Claude the selected endpoint and token while clearing conflicting authentication modes", () => {
		const parentEnv = {
			PATH: "original-path",
			ANTHROPIC_API_KEY: "old-key",
			ANTHROPIC_AUTH_TOKEN: "old-token",
			CLAUDE_CODE_OAUTH_TOKEN: "old-oauth",
			CLAUDE_CODE_USE_BEDROCK: "1",
			CLAUDE_CODE_USE_VERTEX: "1",
			CLAUDE_CODE_USE_FOUNDRY: "1",
		};
		const original = { ...parentEnv };
		const { args, env } = nativeCliModelLaunch(config(), connection, parentEnv);
		expect(args).toEqual([]);
		expect(env).toMatchObject({
			PATH: "original-path",
			ANTHROPIC_BASE_URL: connection.baseUrl,
			ANTHROPIC_AUTH_TOKEN: connection.apiKey,
			ANTHROPIC_MODEL: "configured-model",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "configured-model",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "configured-model",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "configured-model",
			ANTHROPIC_CUSTOM_HEADERS: "X-Provider-Token: private-header-value",
		});
		for (const name of Object.keys(parentEnv).filter((name) => name !== "PATH" && name !== "ANTHROPIC_AUTH_TOKEN")) {
			expect(env).not.toHaveProperty(name);
		}
		expect(parentEnv).toEqual(original);
	});

	it("uses Anthropic API-key authentication for the official endpoint", () => {
		const { env } = nativeCliModelLaunch(config(), { ...connection, baseUrl: "https://api.anthropic.com" }, {});
		expect(env?.ANTHROPIC_API_KEY).toBe(connection.apiKey);
		expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
	});

	it("starts Codex with an explicit Responses provider and keeps all credential values out of argv", () => {
		const { args, env } = nativeCliModelLaunch(config("codex"), connection, { PATH: "original-path" });
		expect(args).toContain('model_provider="pi_web_ui"');
		expect(args).toContain('model_providers.pi_web_ui.base_url="https://configured.test/api"');
		expect(args).toContain('model_providers.pi_web_ui.env_key="PI_WEB_CLI_API_KEY"');
		expect(args).toContain('model_providers.pi_web_ui.wire_api="responses"');
		expect(args).toContain("model_providers.pi_web_ui.requires_openai_auth=false");
		expect(args).toContain(
			'model_providers.pi_web_ui.env_http_headers={"X-Provider-Token"="' +
				["PI", "WEB", "CLI", "HEADER", 0].join("_") +
				'"}',
		);
		expect(JSON.stringify(args)).not.toContain(connection.apiKey);
		expect(JSON.stringify(args)).not.toContain(connection.headers["X-Provider-Token"]);
		expect(env).toMatchObject({
			PATH: "original-path",
			PI_WEB_CLI_API_KEY: connection.apiKey,
			PI_WEB_CLI_HEADER_0: connection.headers["X-Provider-Token"],
		});
	});

	it("keeps native configuration when no inherited connection is available", () => {
		expect(nativeCliModelLaunch(config(), undefined, { PATH: "unchanged" })).toEqual({ args: [] });
		expect(nativeCliModelLaunch({ preset: "claude" }, connection, {})).toEqual({ args: [] });
	});
});
