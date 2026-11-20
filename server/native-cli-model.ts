import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { writeAtomicSync } from "./atomic-file.js";
import type { NativeCliConfig } from "./protocol.js";
import { anthropicBaseUrlFromOpenAi, isLoopbackGatewayUrl, isProtocolSupportedByEngine } from "./model-resolver.js";

export interface NativeCliModelConnection {
	baseUrl: string;
	apiKey: string;
	headers?: Record<string, string>;
	/** The key is a short-lived subscription OAuth access token, not a long-lived API key. */
	isOAuth?: boolean;
	/** Codex custom-provider wire format, derived from the inherited model's protocol. */
	wireApi?: "responses" | "chat";
}

/** ChatGPT account id carried inside a Codex/ChatGPT OAuth JWT (`https://api.openai.com/auth`). */
function extractCodexAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"];
		const id =
			auth && typeof auth === "object" && !Array.isArray(auth)
				? (auth as Record<string, unknown>).chatgpt_account_id
				: undefined;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

export async function resolveNativeCliModelConnection(
	config: NativeCliConfig,
	runtime: ModelRuntime | undefined,
): Promise<NativeCliModelConnection | undefined> {
	if (!runtime || !config.model || (config.preset !== "claude" && config.preset !== "codex")) return undefined;
	const model = runtime.getModel(config.model.provider, config.model.id);
	if (!model) throw new Error(`Inherited CLI model is unavailable: ${config.model.provider}/${config.model.id}`);
	const usingOAuth = runtime.isUsingOAuth(model.provider);
	// Claude Code only speaks Anthropic Messages. A loopback converting gateway (Magpie, Antigravity-Manager
	// and similar, cc-switch style: same key, Anthropic path on the same host) transparently translates any
	// protocol, so derive its Anthropic endpoint instead of giving up. Anything else off-protocol (e.g. an
	// official OpenAI-only endpoint) cannot serve Claude Code: throw so the caller falls back to the CLI's
	// own login with a visible reason instead of a confusing login prompt.
	let gatewayBase: string | undefined;
	if (config.preset === "claude") {
		if (!isProtocolSupportedByEngine(config.preset, model.api)) {
			if (!model.baseUrl || !isLoopbackGatewayUrl(model.baseUrl))
				throw new Error(
					`Inherited model protocol is not supported by claude: ${model.api} (needs an Anthropic-compatible endpoint or a local converting gateway)`,
				);
			gatewayBase = anthropicBaseUrlFromOpenAi(model.baseUrl);
		}
		if (usingOAuth && model.provider !== "anthropic")
			throw new Error(`Inherited OAuth login is not supported by claude: ${model.provider}`);
	} else if (usingOAuth && model.provider !== "openai-codex") {
		// Codex subscription tokens only work against the ChatGPT backend; other OAuth logins stay with the CLI.
		throw new Error(`Inherited OAuth login is not supported by codex: ${model.provider}`);
	}
	const result = await runtime.getAuth(model);
	const fallback = runtime.getCompatibilityRequestConfig(model);
	const apiKey = result?.auth.apiKey;
	if (!apiKey)
		throw new Error(`Inherited CLI model has no usable credentials: ${config.model.provider}/${config.model.id}`);
	const headers = Object.fromEntries(
		Object.entries({ ...fallback.headers, ...result.auth.headers }).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
	if (config.preset === "codex" && usingOAuth) {
		// The ChatGPT backend requires the account id next to the Bearer token (pi-ai derives it the same
		// way); without it the custom provider cannot authenticate, so fall back to the CLI's own login.
		const accountId = extractCodexAccountId(apiKey);
		if (!accountId) throw new Error("Inherited ChatGPT login has no account id, please log in with the Codex CLI");
		headers["chatgpt-account-id"] = accountId;
	}
	return {
		baseUrl: gatewayBase ?? result.auth.baseUrl ?? model.baseUrl,
		apiKey,
		headers,
		isOAuth: usingOAuth,
		...(config.preset === "codex"
			? { wireApi: (model.api === "openai-completions" ? "chat" : "responses") as "responses" | "chat" }
			: {}),
	};
}

/**
 * Variables Claude Code resolves from settings `env`. A user's saved endpoint lives in
 * `~/.claude/settings.json`, and that layer beats inherited process variables, so overriding the
 * process environment alone silently loses to whatever the user (or a config switcher) stored there.
 */
const CLAUDE_SETTINGS_VARIABLES = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"ANTHROPIC_CUSTOM_HEADERS",
] as const;

/**
 * The resolved connection as Claude Code must read it from settings. Conflicting keys are blanked
 * rather than omitted: a blank value disables that mode, while leaving the key unset would let the
 * lower settings layer supply its own value again.
 */
export function claudeSettingsEnv(connection: NativeCliModelConnection, modelId: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of CLAUDE_SETTINGS_VARIABLES) env[key] = "";
	env.ANTHROPIC_BASE_URL = connection.baseUrl;
	if (connection.isOAuth) {
		// A subscription OAuth access token is not an API key: it only authenticates as
		// CLAUDE_CODE_OAUTH_TOKEN (what `claude login` writes), never as x-api-key/Bearer token.
		env.CLAUDE_CODE_OAUTH_TOKEN = connection.apiKey;
	} else {
		const official = new URL(connection.baseUrl).hostname === "api.anthropic.com";
		env[official ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"] = connection.apiKey;
	}
	env.ANTHROPIC_MODEL = modelId;
	for (const tier of ["HAIKU", "SONNET", "OPUS"]) env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = modelId;
	const headers = Object.entries(connection.headers ?? {});
	if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = headers.map(([name, value]) => `${name}: ${value}`).join("\n");
	return env;
}

/** Overlay files hold the provider token, so they live in a private per-user directory, never in argv. */
export function claudeSettingsOverlayDir(): string {
	return join(tmpdir(), "pi-web-ui-cli");
}

/** Stable per-endpoint file name, so restarts overwrite one overlay instead of piling up keys. */
export function claudeSettingsOverlayName(settingsEnv: Record<string, string>): string {
	const identity = `${settingsEnv.ANTHROPIC_BASE_URL ?? ""}|${settingsEnv.ANTHROPIC_MODEL ?? ""}`;
	return `claude-settings-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}.json`;
}

/** Remote overlay path: one 0600 file directly under `/tmp`, so no directory has to be created first. */
export function claudeSettingsRemotePath(settingsEnv: Record<string, string>): string {
	return `/tmp/${claudeSettingsOverlayName(settingsEnv)}`;
}

interface ClaudeSettingsOverlay {
	document: string;
	args: string[];
	index: number;
	joined: boolean;
}

/** Merge the connection into the `--settings` document we already pass, keeping every other key. */
function mergeClaudeSettingsOverlay(
	args: readonly string[],
	settingsEnv: Record<string, string> | undefined,
): ClaudeSettingsOverlay | undefined {
	if (!settingsEnv) return undefined;
	const index = args.findIndex((arg) => arg === "--settings" || arg.startsWith("--settings="));
	if (index < 0) return undefined;
	const joined = args[index] !== "--settings";
	const raw = joined ? args[index].slice("--settings=".length) : args[index + 1];
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const existing = (parsed as { env?: unknown }).env;
	const env =
		existing && typeof existing === "object" && !Array.isArray(existing)
			? { ...(existing as Record<string, string>), ...settingsEnv }
			: settingsEnv;
	return {
		document: JSON.stringify({ ...(parsed as Record<string, unknown>), env }, null, 2) + "\n",
		args: [...args],
		index,
		joined,
	};
}

function pointClaudeSettingsAt(overlay: ClaudeSettingsOverlay, target: string): string[] {
	const next = [...overlay.args];
	if (overlay.joined) next[overlay.index] = `--settings=${target}`;
	else next[overlay.index + 1] = target;
	return next;
}

/**
 * Fold the connection into the `--settings` overlay we already pass for hooks. Settings on the command
 * line outrank `~/.claude/settings.json`, so this wins over a user's stored endpoint without touching
 * their file: every other key — their hooks, permissions, status line — is copied through verbatim.
 * Anything that is not inline JSON (a settings *path*, a user-supplied file) is left exactly as given.
 *
 * The merged document now carries the API key, so it is materialized into a 0600 file and only its path
 * reaches argv — the same reason Codex references credentials through env var names instead of values.
 */
export function withClaudeSettingsEnv(
	args: readonly string[],
	settingsEnv: Record<string, string> | undefined,
	directory = claudeSettingsOverlayDir(),
): string[] {
	const overlay = mergeClaudeSettingsOverlay(args, settingsEnv);
	if (!overlay || !settingsEnv) return [...args];
	const file = join(directory, claudeSettingsOverlayName(settingsEnv));
	try {
		writeAtomicSync(file, overlay.document, { mode: 0o600 });
		return pointClaudeSettingsAt(overlay, file);
	} catch {
		// A read-only temp directory must not block the launch; the inline overlay still carries the same values.
		return pointClaudeSettingsAt(overlay, overlay.document);
	}
}

/**
 * The same overlay for a CLI that runs on another host: the file is materialized there, so the caller
 * gets the document instead of a local path. Only the path travels in argv on either side.
 */
export function claudeSettingsOverlayOnHost(
	args: readonly string[],
	settingsEnv: Record<string, string> | undefined,
	file: string,
): { args: string[]; files: Array<{ path: string; content: string }> } | undefined {
	const overlay = mergeClaudeSettingsOverlay(args, settingsEnv);
	if (!overlay) return undefined;
	return {
		args: pointClaudeSettingsAt(overlay, file),
		files: [{ path: file, content: overlay.document }],
	};
}

export function nativeCliModelLaunch(
	config: NativeCliConfig,
	connection: NativeCliModelConnection | undefined,
	parentEnv: NodeJS.ProcessEnv,
): { args: string[]; env?: NodeJS.ProcessEnv; unsetEnv?: string[]; settingsEnv?: Record<string, string> } {
	if (!config.model || !connection || (config.preset !== "claude" && config.preset !== "codex")) return { args: [] };
	const env = { ...parentEnv };
	if (config.preset === "claude") {
		const settingsEnv = claudeSettingsEnv(connection, config.model.id);
		for (const key of CLAUDE_SETTINGS_VARIABLES) delete env[key];
		// The process environment stays the fallback for launches that carry no settings overlay.
		for (const [key, value] of Object.entries(settingsEnv)) if (value) env[key] = value;
		return {
			args: [],
			env,
			unsetEnv: CLAUDE_SETTINGS_VARIABLES.filter((key) => !Object.hasOwn(env, key)),
			settingsEnv,
		};
	}
	const provider = "pi_web_ui";
	env.PI_WEB_CLI_API_KEY = connection.apiKey;
	const settings: Record<string, string | boolean> = {
		model_provider: provider,
		[`model_providers.${provider}.name`]: "pi-web-ui",
		[`model_providers.${provider}.base_url`]: connection.baseUrl,
		[`model_providers.${provider}.env_key`]: "PI_WEB_CLI_API_KEY",
		// Chat-completions-only endpoints (e.g. DeepSeek) have no Responses API; Codex also speaks `chat`.
		[`model_providers.${provider}.wire_api`]: connection.wireApi ?? "responses",
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
