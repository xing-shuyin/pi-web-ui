import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeAtomicSync } from "../atomic-file.js";

export function createDesktopSetup(options: { dataDir?: string; environmentEnabled: boolean }) {
	const settingsFile = join(resolve(options.dataDir ?? join(homedir(), ".pi-web")), "desktop-settings.json");
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
		setEnabled(enabled: boolean) {
			if (closed) throw new Error("Desktop setup closed");
			writeAtomicSync(settingsFile, JSON.stringify({ enabled }) + "\n", { mode: 0o600 });
			storedEnabled = enabled;
		},
		close() {
			closed = true;
		},
	};
}
