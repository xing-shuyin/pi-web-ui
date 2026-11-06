export const ENGINE_CATALOG = {
	pi: {
		id: "pi",
		name: "Pi",
		packageName: "@earendil-works/pi-coding-agent",
		installCommand: "npm i -g @earendil-works/pi-coding-agent",
		cliCommand: "pi",
		cliModelArgs: "provider-model",
		cliRequiresArgs: false,
	},
	dsh: {
		id: "dsh",
		name: "DSH",
		packageName: "@deepseek-ai/dsh",
		installCommand: "npm i -g @deepseek-ai/dsh",
		cliCommand: null,
		cliModelArgs: null,
		cliRequiresArgs: false,
	},
	claude: {
		id: "claude",
		name: "Claude Code",
		packageName: "@anthropic-ai/claude-code",
		installCommand: "npm i -g @anthropic-ai/claude-code",
		cliCommand: "claude",
		cliModelArgs: "model",
		cliRequiresArgs: false,
	},
	codex: {
		id: "codex",
		name: "Codex",
		packageName: "@openai/codex",
		installCommand: "npm i -g @openai/codex",
		cliCommand: "codex",
		cliModelArgs: "model",
		cliRequiresArgs: false,
	},
	agy: {
		id: "agy",
		name: "Antigravity",
		packageName: null,
		installCommand: "https://antigravity.google/docs/getting-started?tab=cli",
		cliCommand: "agy",
		cliModelArgs: "model",
		cliRequiresArgs: false,
	},
	durable: {
		id: "durable",
		name: "Pi Durable",
		packageName: "@earendil-works/pi-durable",
		installCommand: "npm i -g @earendil-works/pi-durable",
		cliCommand: null,
		cliModelArgs: null,
		cliRequiresArgs: false,
	},
} as const;

export type NativeCliEngineId = keyof typeof ENGINE_CATALOG;
export type BuiltinEngineId = {
	[Id in NativeCliEngineId]: (typeof ENGINE_CATALOG)[Id]["packageName"] extends string ? Id : never;
}[NativeCliEngineId];

export type NativeCliInheritModel = Partial<Record<NativeCliEngineId, boolean>>;

export function normalizeNativeCliInheritModel(value: unknown): NativeCliInheritModel {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: NativeCliInheritModel = {};
	for (const engine of Object.values(ENGINE_CATALOG)) {
		const enabled = (value as Record<string, unknown>)[engine.id];
		if (engine.cliModelArgs && Object.hasOwn(value, engine.id) && typeof enabled === "boolean") {
			result[engine.id] = enabled;
		}
	}
	return result;
}

export function isNativeCliEngineId(value: unknown): value is NativeCliEngineId {
	return typeof value === "string" && Object.hasOwn(ENGINE_CATALOG, value);
}

export function isBuiltinEngineId(value: unknown): value is BuiltinEngineId {
	return isNativeCliEngineId(value) && ENGINE_CATALOG[value].packageName !== null;
}
