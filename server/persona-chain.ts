import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { splitExtensionWrap } from "./prompt-composer.js";

export const INLINE_PERSONA_EXT = "<inline:pi-webui-persona>";

export function splitAgentStartPrompt(event: {
	readonly systemPrompt: string;
	systemPromptOptions?: { forceSystemPrompt?: string };
}): { pre: string; core: string; post: string } {
	const current = event.systemPrompt;
	const opts = event.systemPromptOptions;
	const forced = opts?.forceSystemPrompt;
	if (!opts || typeof forced !== "string") return { pre: "", core: current, post: "" };
	try {
		opts.forceSystemPrompt = undefined;
		return splitExtensionWrap(event.systemPrompt, current);
	} finally {
		opts.forceSystemPrompt = forced;
	}
}

export const PI_DOC_PATHS = (() => {
	try {
		const requireLocal = createRequire(import.meta.url);
		const root = dirname(requireLocal.resolve("@earendil-works/pi-coding-agent/package.json"));
		return { readme: join(root, "README.md"), docs: join(root, "docs"), examples: join(root, "examples") };
	} catch {
		return { readme: "", docs: "", examples: "" };
	}
})();
