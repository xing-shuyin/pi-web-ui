/**
 * Remote-catalog merge patch for @earendil-works/pi-coding-agent.
 *
 * The SDK composes each built-in provider's model list as
 *     mergeModels(builtinStaticCatalog, pi.devRemoteCatalog)
 * which is a UNION: same-id entries get replaced by the newer pi.dev row, new
 * ids are appended, but stale built-in models are kept forever (and the UI
 * reports "新增 N 个模型" when the overlay grows).
 *
 * pi-web-ui wants the picker to mirror the OFFICIAL remote catalog exactly —
 * an "ensure latest, no merge, no 'new N' noise" behavior. This module rewrites
 * the installed copy of remote-catalog-provider.js so the remote overlay
 * REPLACES the built-in catalog entirely whenever pi.dev data is present:
 *     getModels: () => (dynamicModels.length > 0 ? dynamicModels : provider.getModels())
 * (the built-in catalog only serves as fallback while no remote data has been
 * received yet, so the list can never be empty).
 *
 * Same pattern as patch-node-pty.ts: idempotent (checks before rewriting),
 * best-effort (a read-only node_modules or an SDK version whose source no
 * longer matches the search strings just skips the patch and keeps the SDK's
 * default union semantics — never a crash). MUST be imported before the SDK
 * modules are first loaded (agent-service.ts imports this first).
 */
import { existsSync, readFileSync } from "node:fs";
import { writeAtomicSync } from "./atomic-file.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Supported patch pairs across SDK versions (0.87.x, 1.1.0+). */
const PATCH_PAIRS = [
	// SDK 0.87.x
	{
		old: "getModels: () => mergeModels(provider.getModels(), dynamicModels),",
		new: "getModels: () => (dynamicModels.length > 0 ? dynamicModels : provider.getModels()),",
	},
	// SDK 1.1.0+ (typed model shards: chat, image, classifier)
	{
		old: 'getModels: () => mergeModels(provider.getModels(), dynamicModels.filter((model) => isModelType(model, "chat"))),',
		new: 'getModels: () => (dynamicModels.length > 0 ? dynamicModels.filter((model) => isModelType(model, "chat")) : provider.getModels()),',
	},
	{
		old: "getAllModels: () => mergeModels(provider.getAllModels?.() ?? provider.getModels(), dynamicModels),",
		new: "getAllModels: () => (dynamicModels.length > 0 ? dynamicModels : (provider.getAllModels?.() ?? provider.getModels())),",
	},
];

/** Absolute path of the installed remote-catalog-provider.js, or null. */
function remoteCatalogFile(): string | null {
	try {
		// import.meta.resolve honors the package "exports" (import condition) → dist/index.js;
		// remote-catalog-provider.js lives next to it in dist/core/.
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		return join(dirname(entry), "core", "remote-catalog-provider.js");
	} catch {
		return null;
	}
}

function applyPatch(): void {
	try {
		const file = remoteCatalogFile();
		if (!file || !existsSync(file)) return;
		let src = readFileSync(file, "utf8");
		let changed = false;
		for (const { old: oldPattern, new: newPattern } of PATCH_PAIRS) {
			if (src.includes(oldPattern) && !src.includes(newPattern)) {
				src = src.replace(oldPattern, newPattern);
				changed = true;
			}
		}
		if (changed) {
			writeAtomicSync(file, src);
		}
	} catch {
		// best-effort — without the patch the SDK keeps its default union merge
	}
}

applyPatch();
