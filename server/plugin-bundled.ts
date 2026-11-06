import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { BUILTIN_MODULE_IDS, isBuiltinModule } from "./builtin-modules.js";

const ID_RE = /^[A-Za-z0-9_-]+$/;

function preparePayload(dataDir: string, catalogPath: string, id: string): boolean {
	const source = join(dirname(catalogPath), id);
	const target = join(dataDir, "plugins", id);
	if (existsSync(target)) return true;
	if (!existsSync(join(source, "manifest.json"))) return false;
	const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
	if (manifest.id !== id) return false;
	mkdirSync(dirname(target), { recursive: true });
	const staging = mkdtempSync(join(dirname(target), ".bundled-"));
	try {
		cpSync(source, staging, {
			recursive: true,
			filter: (path) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(path),
		});
		renameSync(staging, target);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	return true;
}

export function prepareBundledPlugins(dataDir: string, catalogPath: string, overriddenIds = new Set<string>()): void {
	for (const id of BUILTIN_MODULE_IDS) preparePayload(dataDir, catalogPath, id);

	const catalog: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
	if (!Array.isArray(catalog)) return;
	const optional = catalog.filter(
		(entry) =>
			entry &&
			entry.preinstall === true &&
			typeof entry.id === "string" &&
			ID_RE.test(entry.id) &&
			!isBuiltinModule(entry.id),
	);
	if (!optional.length) return;
	const receiptPath = join(dataDir, "bundled-plugin-installs.json");
	let initialized = new Set<string>();
	if (existsSync(receiptPath)) {
		const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
		if (
			!receipt ||
			typeof receipt !== "object" ||
			!("ids" in receipt) ||
			!Array.isArray(receipt.ids) ||
			!receipt.ids.every((id) => typeof id === "string" && ID_RE.test(id))
		) {
			throw new Error("Invalid bundled plugin installation receipt");
		}
		initialized = new Set(receipt.ids);
	}
	let changed = false;
	for (const entry of optional) {
		const id: string = entry.id;
		if (initialized.has(id)) continue;
		if (!overriddenIds.has(id) && !preparePayload(dataDir, catalogPath, id)) continue;
		initialized.add(id);
		changed = true;
	}
	if (changed) writeJsonAtomicSync(receiptPath, { version: 1, ids: [...initialized].sort() });
}
