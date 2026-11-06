import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultAgentDir(agentDir?: string): string {
	return agentDir && agentDir.trim()
		? agentDir.trim()
		: (process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
}

export interface ResolvedProviderCredential {
	providerId: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
}

export interface CustomModelEntry {
	providerId: string;
	providerName?: string;
	modelId: string;
	name: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	vision?: boolean;
}

import { stripJsonComments, parseJsonWithComments } from "./json-utils.js";
export { stripJsonComments, parseJsonWithComments };

export function readModelsJson(agentDir?: string): { providers: Record<string, Record<string, unknown>> } {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "models.json");
	if (!existsSync(filePath)) return { providers: {} };
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(stripJsonComments(raw)) as {
			providers?: Record<string, Record<string, unknown>>;
		};
		return { providers: parsed?.providers ?? {} };
	} catch {
		return { providers: {} };
	}
}

export function readAuthJson(agentDir?: string): Record<string, unknown> {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "auth.json");
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf8");
		return (JSON.parse(raw) as Record<string, unknown>) ?? {};
	} catch {
		return {};
	}
}

export function readProviderKeysJson(agentDir?: string): Record<
	string,
	{
		activeKeyName: string | null;
		keys: Array<{ name: string; apiKey: string }>;
	}
> {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "provider-keys.json");
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf8");
		return JSON.parse(raw) as Record<
			string,
			{
				activeKeyName: string | null;
				keys: Array<{ name: string; apiKey: string }>;
			}
		>;
	} catch {
		return {};
	}
}

export function resolveProviderCredential(
	agentDir: string | undefined,
	providerId: string,
): ResolvedProviderCredential {
	const dir = defaultAgentDir(agentDir);
	const pid = providerId.trim();
	const { providers } = readModelsJson(dir);
	const prov = providers[pid];

	let baseUrl: string | undefined = typeof prov?.baseUrl === "string" ? prov.baseUrl.trim() : undefined;
	let apiKey: string | undefined = typeof prov?.apiKey === "string" ? prov.apiKey.trim() : undefined;
	const api: string | undefined = typeof prov?.api === "string" ? prov.api.trim() : undefined;
	const headers: Record<string, string> | undefined =
		prov?.headers && typeof prov.headers === "object" && !Array.isArray(prov.headers)
			? (prov.headers as Record<string, string>)
			: undefined;

	if (!apiKey) {
		const multiKeys = readProviderKeysJson(dir);
		const entry = multiKeys[pid];
		if (entry?.keys && entry.keys.length > 0) {
			const active = entry.keys.find((k) => k.name === entry.activeKeyName);
			apiKey = active?.apiKey ?? entry.keys[0]?.apiKey;
		}
	}

	if (!apiKey) {
		const auth = readAuthJson(dir);
		const authEntry = auth[pid];
		if (authEntry && typeof authEntry === "object" && "key" in authEntry) {
			const k = (authEntry as { key?: unknown }).key;
			if (typeof k === "string" && k.trim()) apiKey = k.trim();
		} else if (typeof authEntry === "string" && authEntry.trim()) {
			apiKey = authEntry.trim();
		}
	}

	if (!apiKey) {
		const normPid = pid.toLowerCase();
		if (normPid === "anthropic" || normPid.includes("claude")) {
			apiKey = process.env.ANTHROPIC_API_KEY?.trim();
		} else if (normPid === "deepseek") {
			apiKey = process.env.DEEPSEEK_API_KEY?.trim();
		} else if (normPid === "openai") {
			apiKey = process.env.OPENAI_API_KEY?.trim();
		} else if (normPid === "openrouter") {
			apiKey = process.env.OPENROUTER_API_KEY?.trim();
		} else if (normPid === "google" || normPid.includes("gemini")) {
			apiKey = process.env.GEMINI_API_KEY?.trim() ?? process.env.GOOGLE_API_KEY?.trim();
		}
	}

	if (!baseUrl) {
		const normPid = pid.toLowerCase();
		if (normPid === "anthropic" || normPid.includes("claude")) {
			baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
		} else if (normPid === "deepseek") {
			baseUrl = process.env.DEEPSEEK_BASE_URL?.trim();
		} else if (normPid === "openai") {
			baseUrl = process.env.OPENAI_BASE_URL?.trim();
		}
	}

	return {
		providerId: pid,
		baseUrl: baseUrl || undefined,
		apiKey: apiKey || undefined,
		api: api || undefined,
		headers,
	};
}

export function listCustomModelsFromConfig(
	agentDir?: string,
	filter?: (entry: { providerId: string; api?: string; baseUrl?: string; modelId?: string }) => boolean,
): CustomModelEntry[] {
	const dir = defaultAgentDir(agentDir);
	const { providers } = readModelsJson(dir);
	const results: CustomModelEntry[] = [];

	for (const [providerId, p] of Object.entries(providers)) {
		const api = typeof p.api === "string" ? p.api.trim() : undefined;
		const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl.trim() : undefined;
		const providerName = typeof p.name === "string" ? p.name.trim() : undefined;

		if (Array.isArray(p.models)) {
			for (const m of p.models) {
				if (!m || typeof m !== "object") continue;
				const row = m as Record<string, unknown>;
				const modelId = typeof row.id === "string" ? row.id.trim() : "";
				if (!modelId) continue;

				if (filter && !filter({ providerId, api, baseUrl, modelId })) {
					continue;
				}

				const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : modelId;
				results.push({
					providerId,
					providerName,
					modelId,
					name,
					api,
					baseUrl,
					reasoning: Boolean(row.reasoning),
					vision: Array.isArray(row.input) ? row.input.includes("image") : undefined,
				});
			}
		}
	}

	return results;
}

export type KnownModelProtocol =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "ollama"
	| "bedrock"
	| string;

export function resolveModelProtocol(api?: string, providerId?: string, modelId?: string): KnownModelProtocol {
	const rawApi = (api ?? "").trim().toLowerCase();
	if (rawApi) {
		if (rawApi === "anthropic-messages" || rawApi === "anthropic") return "anthropic-messages";
		if (rawApi === "openai-completions" || rawApi === "openai") return "openai-completions";
		if (rawApi === "openai-responses") return "openai-responses";
		if (rawApi === "google-generative-ai" || rawApi === "gemini" || rawApi === "google") {
			return "google-generative-ai";
		}
		return rawApi;
	}

	const pid = (providerId ?? "").trim().toLowerCase();
	const mid = (modelId ?? "").trim().toLowerCase();

	if (
		pid.includes("openai") ||
		pid.includes("deepseek") ||
		pid.includes("groq") ||
		pid.includes("mistral") ||
		pid.includes("openrouter")
	) {
		return "openai-completions";
	}
	if (pid === "anthropic" || pid.includes("claude") || pid.includes("anthropic")) {
		return "anthropic-messages";
	}
	if (pid === "google-vertex") return "google-vertex";
	if (pid === "google" || pid === "gemini") {
		return "google-generative-ai";
	}
	if (pid === "ollama") return "ollama";
	if (pid === "bedrock") return "bedrock";

	if (mid.startsWith("claude")) {
		return "anthropic-messages";
	}
	if (mid.startsWith("gemini")) {
		return "google-generative-ai";
	}

	return "openai-completions";
}

export function isProtocolSupportedByEngine(
	engine: string,
	api?: string,
	providerId?: string,
	modelId?: string,
): boolean {
	const normEngine = engine.toLowerCase().trim();
	const protocol = resolveModelProtocol(api, providerId, modelId);

	if (normEngine === "pi") {
		return true;
	}

	if (normEngine === "dsh") {
		return protocol === "openai-completions" || protocol === "openai-responses";
	}

	if (normEngine === "claude") {
		return protocol === "anthropic-messages";
	}

	if (normEngine === "durable") {
		return (
			protocol === "openai-completions" ||
			protocol === "openai-responses" ||
			protocol === "anthropic-messages" ||
			protocol === "google-generative-ai" ||
			protocol === "google-vertex"
		);
	}

	return true;
}

export interface GlobalAgentSettings {
	defaultThinkingLevel?: string;
	modelThinkingLevels?: Record<string, string>;
	[key: string]: unknown;
}

export function readGlobalSettings(agentDir?: string): GlobalAgentSettings {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "settings.json");
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf8");
		return JSON.parse(stripJsonComments(raw)) as GlobalAgentSettings;
	} catch {
		return {};
	}
}

export function getModelThinkingLevelFromSettings(modelId?: string, agentDir?: string): string | undefined {
	if (!modelId) return undefined;
	const settings = readGlobalSettings(agentDir);
	const levels = settings.modelThinkingLevels;
	if (levels && typeof levels === "object") {
		if (levels[modelId]) return levels[modelId];
		const slashIdx = modelId.indexOf("/");
		const bareId = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;
		for (const [k, v] of Object.entries(levels)) {
			if (k === bareId || k.endsWith(`/${bareId}`)) {
				return v;
			}
		}
	}
	return settings.defaultThinkingLevel;
}

export function saveModelThinkingLevelToSettings(modelId: string, level: string, agentDir?: string): void {
	if (!modelId || !level) return;
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "settings.json");
	try {
		let current: Record<string, unknown> = {};
		if (existsSync(filePath)) {
			try {
				current = JSON.parse(stripJsonComments(readFileSync(filePath, "utf8")));
			} catch {}
		}
		const existingLevels = (
			current.modelThinkingLevels && typeof current.modelThinkingLevels === "object"
				? { ...(current.modelThinkingLevels as Record<string, string>) }
				: {}
		) as Record<string, string>;
		existingLevels[modelId] = level;
		current.modelThinkingLevels = existingLevels;
		const formatted = JSON.stringify(current, null, 2);
		writeFileSync(filePath, formatted, "utf8");
	} catch {}
}

export function isModelProtocolSupportedByEngine(
	engine: string,
	meta: {
		api?: string;
		providerId: string;
		modelId?: string;
	},
): boolean {
	return isProtocolSupportedByEngine(engine, meta.api, meta.providerId, meta.modelId);
}
