#!/usr/bin/env node
import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(process.env.PI_HUB_TEST_TMP || tmpdir(), "hub-release-"));
const stage = join(work, "source"),
	artifacts = join(work, "artifacts");
const excluded = new Set(["node_modules", ".git", "dist", ".worktrees", ".pi", "coverage", ".cache"]);
await cp(source, stage, {
	recursive: true,
	filter: (path) =>
		!relative(source, path)
			.split(sep)
			.some((part) => excluded.has(part)),
});
await symlink(
	join(source, "node_modules"),
	join(stage, "node_modules"),
	process.platform === "win32" ? "junction" : "dir",
);
await mkdir(artifacts);
const npm = [
	join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
	join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(existsSync);
if (!npm) throw new Error("npm must be installed beside Node");
const run = (args) =>
	new Promise((done, reject) => {
		const child = spawn(process.execPath, [npm, ...args], { cwd: stage, stdio: "inherit", windowsHide: true });
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? done() : reject(new Error(`npm ${args[0]} exited ${code}`))));
	});
console.log(`[hub-release] Isolated build: ${stage}`);
await run(["run", "build"]);
await run(["pack", "--ignore-scripts", "--pack-destination", artifacts]);
await writeFile(join(work, "build-location.json"), JSON.stringify({ stage, artifacts }, null, 2));
console.log(`[hub-release] Candidate tarball: ${artifacts}`);
