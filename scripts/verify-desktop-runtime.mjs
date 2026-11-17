#!/usr/bin/env node
// 运行时归档验收（P1）：签名 → 清单结构 → 归档摘要 → 逐条白名单。任何一项不过就退出 1。
//
// 用法：
//   node scripts/verify-desktop-runtime.mjs --manifest release/runtime/runtime.json \
//     --signature release/runtime/runtime.json.sig --archive release/runtime/core-0.121.0-win32-x64.tar.zst \
//     --public-key release/runtime/runtime.json.pub.pem
//
// 没有公钥又想跑本地流水线时加 --allow-unsigned（CI 里禁止）。

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createZstdDecompress } from "node:zlib";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestModule = await import(pathToFileURL(join(repoRoot, "dist", "desktop", "runtime-manifest.js")).href).catch(
	() => null,
);
if (!manifestModule) throw new Error("缺少 dist/desktop/runtime-manifest.js，先跑 `npm run build:desktop`");
const { checkArchiveEntryPath, checkArchiveEntryType, parseRuntimeManifest, verifyManifestSignature } = manifestModule;

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i];
		const next = () => argv[++i];
		switch (key) {
			case "--manifest":
				args.manifest = next();
				break;
			case "--signature":
				args.signature = next();
				break;
			case "--archive":
				args.archive = next();
				break;
			case "--public-key":
				args.publicKey = next();
				break;
			case "--allow-unsigned":
				args.allowUnsigned = true;
				break;
			default:
				throw new Error(`未知参数：${key}`);
		}
	}
	if (!args.manifest) throw new Error("必须给 --manifest");
	return args;
}

const problems = [];
function fail(message) {
	problems.push(message);
}

async function listArchiveEntries(archivePath) {
	const entries = [];
	await pipeline(
		createReadStream(archivePath),
		createZstdDecompress(),
		tar.t({
			onentry: (entry) => {
				entries.push({ path: entry.path, type: entry.type, size: entry.size });
			},
		}),
	);
	return entries;
}

async function sha256File(path) {
	return await new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("error", reject)
			.on("data", (chunk) => hash.update(chunk))
			.on("end", () => resolve(hash.digest("hex")));
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const manifestText = readFileSync(args.manifest, "utf8");

	if (args.signature && args.publicKey) {
		const ok = verifyManifestSignature({
			manifestText,
			signatureBase64: readFileSync(args.signature, "utf8").trim(),
			publicKeyPem: readFileSync(args.publicKey, "utf8"),
		});
		if (!ok) fail("清单签名校验失败");
		else console.log("✔ 清单签名");
	} else if (!args.allowUnsigned) {
		fail("没有 --public-key/--signature，且未显式 --allow-unsigned");
	} else {
		console.warn("⚠ 跳过签名校验（--allow-unsigned）");
	}

	let manifest = null;
	try {
		manifest = parseRuntimeManifest(JSON.parse(manifestText));
	} catch {
		fail("清单不是合法 JSON");
	}
	if (!manifest) fail("清单结构不合规（parseRuntimeManifest 返回 null）");
	if (!manifest) return finish();
	console.log(
		`✔ 清单 version=${manifest.version} protocol=${manifest.protocol} minShell=${manifest.minShell} payloads=${manifest.payloads.length}`,
	);

	if (args.archive) {
		if (!existsSync(args.archive)) {
			fail(`归档不存在：${args.archive}`);
			return finish();
		}
		const target = manifest.payloads.find((payload) => args.archive.endsWith(`/${payload.url.split("/").pop()}`));
		if (!target) fail(`清单里没有与归档同名的载荷：${args.archive}`);
		const size = readFileSync(args.archive).length;
		if (target) {
			if (size !== target.size) fail(`归档大小 ${size} ≠ 清单 ${target.size}`);
			const digest = await sha256File(args.archive);
			if (digest !== target.sha256) fail(`归档 sha256 ${digest.slice(0, 16)}… ≠ 清单 ${target.sha256.slice(0, 16)}…`);
			if (problems.length === 0) console.log(`✔ 归档摘要 ${(size / 1048576).toFixed(1)} MB`);
		}
		const entries = await listArchiveEntries(args.archive);
		for (const entry of entries) {
			const pathVerdict = checkArchiveEntryPath(entry.path);
			if (!pathVerdict.ok) fail(pathVerdict.reason);
			const typeVerdict = checkArchiveEntryType(entry.type, entry.path);
			if (!typeVerdict.ok) fail(typeVerdict.reason);
		}
		const hasEntry = entries.some(
			(entry) => entry.path === "dist/server/index.js" || entry.path.endsWith("/dist/server/index.js"),
		);
		if (!hasEntry) fail("归档里没有 dist/server/index.js");
		console.log(`✔ 归档条目 ${entries.length}（白名单逐条通过）`);
	}
	return finish();
}

function finish() {
	if (problems.length > 0) {
		for (const problem of problems) console.error(`✖ ${problem}`);
		process.exitCode = 1;
		return;
	}
	console.log("✔ 运行时产物验收通过");
}

main().catch((error) => {
	console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
