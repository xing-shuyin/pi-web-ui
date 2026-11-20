import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	nativeCliModelLaunch,
	resolveNativeCliModelConnection,
	withClaudeSettingsEnv,
} from "../../server/native-cli-model.js";
import type { NativeCliConfig } from "../../server/protocol.js";

const config = (preset: "claude" | "codex" = "claude"): NativeCliConfig => ({
	preset,
	model: { provider: "configured-provider", id: "configured-model" },
});

function runtime(model: Record<string, unknown> = {}) {
	return {
		getModel: vi.fn(() => ({
			provider: "configured-provider",
			id: "configured-model",
			api: "anthropic-messages",
			baseUrl: "https://configured.test",
			...model,
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

const CHATGPT_JWT =
	"eyJhbGciOiJIUzI1NiJ9." +
	Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test-123" } })).toString(
		"base64url",
	) +
	".signature";

describe("native CLI model connection", () => {
	it("uses the SDK's current auth, base URL and configured headers", async () => {
		const models = runtime();
		expect(await resolveNativeCliModelConnection(config(), models)).toEqual({
			baseUrl: "https://resolved.test",
			apiKey: "resolved-test-key",
			headers: { "X-Configured": "configured-header", "X-Auth": "auth-header" },
			isOAuth: false,
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
		expect(await resolveNativeCliModelConnection({ ...config(), preset: "pi" }, models)).toBeUndefined();
		expect(models.getModel).not.toHaveBeenCalled();
	});

	it("forwards subscription OAuth to Claude as an OAuth token instead of an API key", async () => {
		const models = runtime({ provider: "anthropic", api: "anthropic-messages" });
		models.isUsingOAuth.mockReturnValue(true);
		models.getAuth.mockResolvedValue({ auth: { apiKey: "sk-ant-oat-test-token" } });
		const connection = await resolveNativeCliModelConnection(config(), models);
		expect(connection).toMatchObject({ apiKey: "sk-ant-oat-test-token", isOAuth: true });
		const { settingsEnv } = nativeCliModelLaunch(config(), connection!, {});
		expect(settingsEnv).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test-token",
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_AUTH_TOKEN: "",
		});
	});

	it("rejects OAuth logins Claude cannot serve", async () => {
		const models = runtime({ provider: "google", api: "google-generative-ai", baseUrl: "https://google.test" });
		models.isUsingOAuth.mockReturnValue(true);
		await expect(resolveNativeCliModelConnection(config(), models)).rejects.toThrow("not supported by claude");
		expect(models.getAuth).not.toHaveBeenCalled();
	});

	it("reports missing credentials instead of silently keeping the CLI login", async () => {
		const models = runtime();
		models.getAuth.mockResolvedValue(undefined);
		await expect(resolveNativeCliModelConnection(config(), models)).rejects.toThrow("no usable credentials");
	});

	it("derives the Anthropic endpoint for loopback converting gateways, cc-switch style", async () => {
		const models = runtime({
			provider: "gateway",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:3425/v1",
		});
		const connection = await resolveNativeCliModelConnection(config(), models);
		expect(connection).toMatchObject({ baseUrl: "http://127.0.0.1:3425", isOAuth: false });
	});

	it("rejects official non-Anthropic endpoints for Claude so the CLI falls back with a reason", async () => {
		const models = runtime({
			provider: "deepseek",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com/v1",
		});
		await expect(resolveNativeCliModelConnection(config(), models)).rejects.toThrow(
			"Inherited model protocol is not supported by claude",
		);
	});

	it("forwards Codex subscription OAuth with the ChatGPT account id header", async () => {
		const models = runtime({ provider: "openai-codex", api: "openai-codex-responses" });
		models.isUsingOAuth.mockReturnValue(true);
		models.getAuth.mockResolvedValue({ auth: { apiKey: CHATGPT_JWT } });
		const connection = await resolveNativeCliModelConnection(config("codex"), models);
		expect(connection).toMatchObject({
			isOAuth: true,
			wireApi: "responses",
			headers: expect.objectContaining({ "chatgpt-account-id": "acct-test-123" }),
		});
		const launched = nativeCliModelLaunch(config("codex"), connection!, { PATH: "original-path" });
		expect(JSON.stringify(launched.args)).toContain("chatgpt-account-id");
		expect(launched.env?.PI_WEB_CLI_API_KEY).toBe(CHATGPT_JWT);
	});

	it("rejects Codex OAuth from providers that are not the ChatGPT backend", async () => {
		const models = runtime({ provider: "anthropic", api: "anthropic-messages" });
		models.isUsingOAuth.mockReturnValue(true);
		await expect(resolveNativeCliModelConnection(config("codex"), models)).rejects.toThrow("not supported by codex");
	});

	it("maps chat-completions-only models to the Codex chat wire API", async () => {
		const models = runtime({ provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" });
		const connection = await resolveNativeCliModelConnection(config("codex"), models);
		expect(connection).toMatchObject({ wireApi: "chat" });
		const launched = nativeCliModelLaunch(config("codex"), connection!, {});
		expect(launched.args).toContain('model_providers.pi_web_ui.wire_api="chat"');
	});

	it("leaves agy on its own login and model names", async () => {
		const models = runtime({ provider: "google", api: "google-generative-ai" });
		expect(
			await resolveNativeCliModelConnection(
				{ preset: "agy", model: { provider: "google", id: "gemini-model" } },
				models,
			),
		).toBeUndefined();
		expect(models.getModel).not.toHaveBeenCalled();
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

describe("claude settings overlay", () => {
	const connection = {
		baseUrl: "https://relay.test/api",
		apiKey: "private-test-key",
		headers: { "X-Provider-Token": "private-header-value" },
	};
	const overlayDir = () => mkdtempSync(join(tmpdir(), "pi-cli-overlay-"));
	const overlayOf = (args: string[], at: number) => JSON.parse(readFileSync(args[at], "utf8"));

	it("exposes the connection as settings env, blanking the modes it must not inherit", () => {
		const { settingsEnv } = nativeCliModelLaunch(config(), connection, { PATH: "original-path" });
		expect(settingsEnv).toMatchObject({
			ANTHROPIC_BASE_URL: connection.baseUrl,
			ANTHROPIC_AUTH_TOKEN: connection.apiKey,
			ANTHROPIC_API_KEY: "",
			CLAUDE_CODE_OAUTH_TOKEN: "",
			CLAUDE_CODE_USE_BEDROCK: "",
			CLAUDE_CODE_USE_VERTEX: "",
			CLAUDE_CODE_USE_FOUNDRY: "",
			ANTHROPIC_MODEL: "configured-model",
		});
	});

	it("merges into the settings overlay we already pass, keeping hooks and every other key", () => {
		const hooks = {
			hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "report done", timeout: 5 }] }] },
		};
		const args = ["--resume", "session-id", "--settings", JSON.stringify(hooks)];
		const { settingsEnv } = nativeCliModelLaunch(config(), connection, {});
		const merged = withClaudeSettingsEnv(args, settingsEnv, overlayDir());
		expect(merged).not.toBe(args);
		expect(merged.slice(0, 3)).toEqual(["--resume", "session-id", "--settings"]);
		const document = overlayOf(merged, 3);
		expect(document.hooks).toEqual(hooks.hooks);
		expect(document.env).toMatchObject({ ANTHROPIC_BASE_URL: connection.baseUrl });
	});

	it("keeps the token out of argv by passing a private overlay file instead", () => {
		const directory = overlayDir();
		const args = ["--settings", JSON.stringify({ hooks: {} })];
		const { settingsEnv } = nativeCliModelLaunch(config(), connection, {});
		const merged = withClaudeSettingsEnv(args, settingsEnv, directory);
		expect(JSON.stringify(merged)).not.toContain(connection.apiKey);
		expect(merged[1].startsWith(directory)).toBe(true);
		// Windows does not map read-only bits onto rwx, so the 0600 contract is only observable on POSIX.
		if (process.platform !== "win32") expect(statSync(merged[1]).mode & 0o777).toBe(0o600);
		expect(overlayOf(merged, 1)).toMatchObject({ env: { ANTHROPIC_AUTH_TOKEN: connection.apiKey } });
		// Stable name: a restart overwrites the same file instead of accumulating keys.
		expect(withClaudeSettingsEnv(args, settingsEnv, directory)[1]).toBe(merged[1]);
	});

	it("keeps an env object the user put in the overlay and lets the connection win", () => {
		const args = ["--settings", JSON.stringify({ env: { KEEP_ME: "1", ANTHROPIC_BASE_URL: "https://stale.test" } })];
		const merged = withClaudeSettingsEnv(args, { ANTHROPIC_BASE_URL: "https://fresh.test" }, overlayDir());
		expect(overlayOf(merged, 1).env).toEqual({ KEEP_ME: "1", ANTHROPIC_BASE_URL: "https://fresh.test" });
	});

	it("supports the joined --settings= form", () => {
		const merged = withClaudeSettingsEnv(['--settings={"hooks":{}}'], { A: "1" }, overlayDir());
		expect(JSON.parse(readFileSync(merged[0].slice("--settings=".length), "utf8"))).toEqual({
			hooks: {},
			env: { A: "1" },
		});
	});

	it("never rewrites a settings path, an absent overlay, or a launch with no connection", () => {
		const directory = overlayDir();
		expect(withClaudeSettingsEnv(["--settings", "./my.json"], { A: "1" }, directory)).toEqual([
			"--settings",
			"./my.json",
		]);
		expect(withClaudeSettingsEnv(["--resume", "id"], { A: "1" }, directory)).toEqual(["--resume", "id"]);
		expect(withClaudeSettingsEnv(["--settings"], { A: "1" }, directory)).toEqual(["--settings"]);
		expect(withClaudeSettingsEnv(["--settings", "{}"], undefined, directory)).toEqual(["--settings", "{}"]);
	});
});
