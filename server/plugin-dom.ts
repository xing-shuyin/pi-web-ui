import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";

const FILE = "plugin-dom.json";

export function declarationWantsDom(permissions: unknown): boolean {
	if (!Array.isArray(permissions)) return false;
	return permissions.some((p) => {
		if (typeof p !== "string") return false;
		const [fam, sub] = p.split(":").map((s) => s.trim().toLowerCase());
		if (fam !== "dom") return false;
		return sub === undefined || sub === "" || sub !== "anchor";
	});
}

export function isDomBundleBlocked(wantsDom: boolean, granted: boolean): boolean {
	return wantsDom && !granted;
}

function readGranted(dataDir: string): Set<string> {
	try {
		const raw = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as { granted?: unknown };
		const list = Array.isArray(raw?.granted) ? raw.granted : [];
		return new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0));
	} catch {
		return new Set();
	}
}

export class PluginDomConsent {
	private granted: Set<string>;

	constructor(private readonly dataDir: string) {
		this.granted = readGranted(dataDir);
	}

	has(pluginId: string): boolean {
		return this.granted.has(pluginId);
	}

	list(): string[] {
		return [...this.granted].sort();
	}

	set(pluginId: string, granted: boolean): boolean {
		const id = String(pluginId ?? "").trim();
		if (!id) return false;
		const had = this.granted.has(id);
		if (granted === had) return false;
		if (granted) this.granted.add(id);
		else this.granted.delete(id);
		try {
			writeJsonAtomicSync(join(this.dataDir, FILE), { v: 1, granted: this.list() });
		} catch {}
		return true;
	}
}
