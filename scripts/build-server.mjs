#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await rm(join(root, "dist/server"), { recursive: true, force: true });
const exitCode = await new Promise((resolve, reject) => {
	const child = spawn(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.server.json"], {
		cwd: root,
		stdio: "inherit",
	});
	child.once("error", reject);
	child.once("exit", (code, signal) => {
		if (signal) reject(new Error(`Server build terminated by ${signal}`));
		else resolve(code ?? 1);
	});
});
process.exitCode = exitCode;
