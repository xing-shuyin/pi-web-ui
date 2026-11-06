import { existsSync, readFileSync } from "node:fs";
import { writeAtomicSync } from "./atomic-file.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PATCH_PAIRS = [
	{
		old: "getModels: () => mergeModels(provider.getModels(), dynamicModels),",
		new: "getModels: () => (dynamicModels.length > 0 ? dynamicModels : provider.getModels()),",
	},
	{
		old: 'getModels: () => mergeModels(provider.getModels(), dynamicModels.filter((model) => isModelType(model, "chat"))),',
		new: 'getModels: () => (dynamicModels.length > 0 ? dynamicModels.filter((model) => isModelType(model, "chat")) : provider.getModels()),',
	},
	{
		old: "getAllModels: () => mergeModels(provider.getAllModels?.() ?? provider.getModels(), dynamicModels),",
		new: "getAllModels: () => (dynamicModels.length > 0 ? dynamicModels : (provider.getAllModels?.() ?? provider.getModels())),",
	},
];

function remoteCatalogFile(): string | null {
	try {
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
	} catch {}
}

applyPatch();
