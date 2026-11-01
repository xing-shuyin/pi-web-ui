import type { LocalBot, LocalBotInput } from "./bots.js";
import type { LocalBotOptions } from "./bot-catalog.js";
import { DeviceWorkspaceError } from "./workspaces.js";

/** Partial Bot presets never carry workspace, identity, credentials or host runtime settings. */
export function applyLocalBotPreset(bot: LocalBot, raw: unknown, catalog: LocalBotOptions): LocalBotInput {
	const fail = (message: string): never => {
		throw new DeviceWorkspaceError(400, "BOT_PRESET_INVALID", message);
	};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Select a Bot preset object");
	const input = raw as Record<string, unknown>;
	const fields = ["model", "tools", "skills", "mcpServers", "systemPrompt"];
	if (!Object.keys(input).length || Object.keys(input).some((key) => !fields.includes(key)))
		fail("Preset supports only model, tools, skills, mcpServers and systemPrompt");
	if (Buffer.byteLength(JSON.stringify(input)) > 96 * 1024) fail("Preset is too large");
	const next: LocalBotInput = { ...bot };
	if ("systemPrompt" in input) {
		if (typeof input.systemPrompt !== "string" || input.systemPrompt.length > 32000) fail("Invalid systemPrompt");
		next.systemPrompt = input.systemPrompt as string;
	}
	for (const field of ["tools", "skills", "mcpServers"] as const) {
		if (!(field in input)) continue;
		const value = input[field];
		if (
			!Array.isArray(value) ||
			value.length > 512 ||
			value.some((item) => typeof item !== "string") ||
			new Set(value).size !== value.length
		)
			fail(`Invalid ${field}`);
		const allowed = new Set(catalog[field].map((item) => item.id));
		if ((value as string[]).some((item) => !allowed.has(item))) fail(`Preset contains unavailable ${field}`);
		next[field] = [...(value as string[])];
	}
	if ("model" in input) {
		const model = input.model as Record<string, unknown> | null;
		if (
			!model ||
			typeof model !== "object" ||
			Array.isArray(model) ||
			Object.keys(model).some((key) => !["provider", "modelId"].includes(key)) ||
			!catalog.models.some((item) => item.provider === model.provider && item.id === model.modelId)
		)
			fail("Preset model is unavailable");
		next.model = { provider: model!.provider as string, modelId: model!.modelId as string };
	}
	return next;
}
