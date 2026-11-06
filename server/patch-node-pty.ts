import { existsSync, readFileSync } from "node:fs";
import { writeAtomicSync } from "./atomic-file.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function ptyPackageDir(): string | null {
	try {
		return dirname(dirname(require.resolve("node-pty")));
	} catch {
		return null;
	}
}

function patchFile(pkgDir: string, rel: string, find: string, replace: string): void {
	try {
		const file = join(pkgDir, rel);
		if (!existsSync(file)) return;
		const src = readFileSync(file, "utf8");
		if (src.includes(replace)) return;
		if (!src.includes(find)) return;
		writeAtomicSync(file, src.replace(find, replace));
	} catch {}
}

function applyPatches(): void {
	const pkgDir = ptyPackageDir();
	if (!pkgDir) return;
	patchFile(
		pkgDir,
		"lib/windowsConoutConnection.js",
		"console.warn('Unexpected ConoutWorkerMessage', message);",
		"break; // pi-web-ui: ignore Node --watch worker messages",
	);
	patchFile(
		pkgDir,
		"lib/windowsPtyAgent.js",
		"agent.on('message', function (message) {\n                clearTimeout(timeout);\n                resolve(message.consoleProcessList);\n            });",
		[
			"            agent.on('message', function (message) {",
			"                // pi-web-ui: ignore Node --watch messages on the fork channel",
			"                if (message && Array.isArray(message.consoleProcessList)) {",
			"                    clearTimeout(timeout);",
			"                    resolve(message.consoleProcessList);",
			"                }",
			"            });",
		].join("\n"),
	);
	patchFile(
		pkgDir,
		"lib/conpty_console_list_agent.js",
		"var consoleProcessList = getConsoleProcessList(shellPid);\nprocess.send({ consoleProcessList: consoleProcessList });\nprocess.exit(0);",
		[
			"try {",
			"    var consoleProcessList = getConsoleProcessList(shellPid);",
			"    process.send({ consoleProcessList: consoleProcessList });",
			"} catch (e) {",
			"    process.send({ consoleProcessList: [] });",
			"}",
			"process.exit(0);",
		].join("\n"),
	);
}

applyPatches();
