/**
 * node-pty × Node `--watch` compatibility patches (dev-server noise).
 *
 * Node's `--watch` mode (the dev script runs `node --watch --import tsx`)
 * pushes `watch:require` / `watch:import` messages over the IPC channels of
 * spawned worker threads AND forked child processes to track module
 * dependencies. node-pty 1.1.0 does not recognize these and mishandles them in
 * two places:
 *
 *  · windowsConoutConnection.js — logs every unknown worker message via
 *    `console.warn`, producing hundreds of "Unexpected ConoutWorkerMessage"
 *    lines per terminal (the SCM panel's hidden query PTY triggers it on every
 *    git-view open).
 *  · windowsPtyAgent.js — the kill path's `_getConsoleProcessList()` treats ANY
 *    message from the forked console-list agent as its reply; a watch message
 *    has no `consoleProcessList` property, so `message.consoleProcessList` is
 *    undefined and the `.forEach` on it crashes the server.
 *
 * Both are benign protocol noise: the ConPTY worker only ever sends its READY
 * sentinel and the agent only sends `{ consoleProcessList }` — both of which
 * node-pty handles. These patches make node-pty ignore unrelated IPC traffic.
 *
 * IMPORTANT: this module MUST be imported before node-pty (see terminals.ts) —
 * it rewrites the installed copies on disk so the subsequently-compiled
 * node-pty modules contain the fixed handlers. Best-effort and idempotent
 * (checks before rewriting), mirroring the spawn-helper chmod self-heal; a
 * read-only node_modules or a different node-pty version just skips the patch
 * (the runtime console.warn filter in terminals.ts still guards the flood).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Absolute path of the installed node-pty package root, or null. */
function ptyPackageDir(): string | null {
	try {
		// require.resolve("node-pty") → <pkg>/lib/index.js → package root is two up.
		return dirname(dirname(require.resolve("node-pty")));
	} catch {
		return null;
	}
}

/** Idempotently replace one code fragment in a node-pty source file. */
function patchFile(pkgDir: string, rel: string, find: string, replace: string): void {
	try {
		const file = join(pkgDir, rel);
		if (!existsSync(file)) return;
		const src = readFileSync(file, "utf8");
		if (src.includes(replace)) return; // already patched
		if (!src.includes(find)) return; // unexpected content — leave alone
		writeFileSync(file, src.replace(find, replace), "utf8");
	} catch {
		// best-effort — the runtime console.warn filter still guards the flood
	}
}

function applyPatches(): void {
	const pkgDir = ptyPackageDir();
	if (!pkgDir) return;
	// 1. ConoutConnection: ignore unknown worker messages instead of warning.
	patchFile(
		pkgDir,
		"lib/windowsConoutConnection.js",
		"console.warn('Unexpected ConoutWorkerMessage', message);",
		"break; // pi-web-ui: ignore Node --watch worker messages",
	);
	// 2. windowsPtyAgent kill path: only accept a real console-list reply
	//    (watch messages arrive first on the fork channel and carry no
	//    consoleProcessList — previously resolved undefined and crashed).
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
}

applyPatches();
