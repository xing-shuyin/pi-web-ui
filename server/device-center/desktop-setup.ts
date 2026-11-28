import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../atomic-file.js";
import { resolveDefaultDataDir } from "../../shared/data-dir.js";

export function createDesktopSetup(options: { dataDir?: string; environmentEnabled: boolean }) {
	const settingsFile = join(resolveDefaultDataDir({ explicit: options.dataDir }), "desktop-settings.json");
	const environmentEnabled = options.environmentEnabled;
	let storedEnabled = false;
	try {
		storedEnabled = JSON.parse(readFileSync(settingsFile, "utf8"))?.enabled === true;
	} catch {}
	let closed = false;
	return {
		get enabled() {
			return environmentEnabled || storedEnabled;
		},
		async setEnabled(enabled: boolean): Promise<void> {
			if (closed) throw new Error("Desktop setup closed");
			await writeAtomic(settingsFile, JSON.stringify({ enabled }) + "\n", { mode: 0o600 });
			storedEnabled = enabled;
		},
		close() {
			closed = true;
		},
	};
}
