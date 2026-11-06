import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { NativeCliConfig } from "./protocol.js";
import { isProtocolSupportedByEngine } from "./model-resolver.js";

export interface NativeCliModelConnection {
	baseUrl: string;
	apiKey: string;
	headers?: Record<string, string>;
}

export async function resolveNativeCliModelConnection(
	config: NativeCliConfig,
	runtime: ModelRuntime | undefined,
): Promise<NativeCliModelConnection | undefined> {
	if (!runtime || !config.model || (config.preset !== "claude" && config.preset !== "codex")) return undefined;
	const model = runtime.getModel(config.model.provider, config.model.id);
	if (!model) throw new Error(`Inherited CLI model is unavailable: ${config.model.provider}/${config.model.id}`);
	if (!isProtocolSupportedByEngine(config.preset, model.api))
		throw new Error(`Inherited model protocol is not supported by ${config.preset}: ${model.api}`);
	if (runtime.isUsingOAuth(model.provider)) return undefined;
	const result = await runtime.getAuth(model);
	const fallback = runtime.getCompatibilityRequestConfig(model);
	const apiKey = result?.auth.apiKey;
	if (!apiKey) return undefined;
	return {
		baseUrl: result.auth.baseUrl ?? model.baseUrl,
		apiKey,
		headers: Object.fromEntries(
			Object.entries({ ...fallback.headers, ...result.auth.headers }).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		),
	};
}

export function nativeCliModelLaunch(
	config: NativeCliConfig,
	connection: NativeCliModelConnection | undefined,
	parentEnv: NodeJS.ProcessEnv,
): { args: string[]; env?: NodeJS.ProcessEnv; unsetEnv?: string[] } {
	if (!config.model || !connection || (config.preset !== "claude" && config.preset !== "codex")) return { args: [] };
	const env = { ...parentEnv };
	if (config.preset === "claude") {
		const authVariables = [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_VERTEX",
			"CLAUDE_CODE_USE_FOUNDRY",
			"ANTHROPIC_CUSTOM_HEADERS",
		];
		for (const key of authVariables) delete env[key];
		env.ANTHROPIC_BASE_URL = connection.baseUrl;
		const official = new URL(connection.baseUrl).hostname === "api.anthropic.com";
		env[official ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"] = connection.apiKey;
		env.ANTHROPIC_MODEL = config.model.id;
		for (const tier of ["HAIKU", "SONNET", "OPUS"]) env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = config.model.id;
		const headers = Object.entries(connection.headers ?? {});
		if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = headers.map(([name, value]) => `${name}: ${value}`).join("\n");
		else delete env.ANTHROPIC_CUSTOM_HEADERS;
		return { args: [], env, unsetEnv: authVariables.filter((key) => !Object.hasOwn(env, key)) };
	}
	const provider = "pi_web_ui";
	env.PI_WEB_CLI_API_KEY = connection.apiKey;
	const settings: Record<string, string | boolean> = {
		model_provider: provider,
		[`model_providers.${provider}.name`]: "pi-web-ui",
		[`model_providers.${provider}.base_url`]: connection.baseUrl,
		[`model_providers.${provider}.env_key`]: "PI_WEB_CLI_API_KEY",
		[`model_providers.${provider}.wire_api`]: "responses",
		[`model_providers.${provider}.requires_openai_auth`]: false,
	};
	const envHeaders = Object.entries(connection.headers ?? {}).map(([name, value], index) => {
		const key = `PI_WEB_CLI_HEADER_${index}`;
		env[key] = value;
		return `${JSON.stringify(name)}=${JSON.stringify(key)}`;
	});
	const args = Object.entries(settings).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
	if (envHeaders.length) args.push("-c", `model_providers.${provider}.env_http_headers={${envHeaders.join(",")}}`);
	return { args, env };
}
