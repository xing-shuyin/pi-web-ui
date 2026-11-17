#!/usr/bin/env node
// 打运行时归档 + 写清单 + 签名（P1）。设计见 docs/architecture-desktop-runtime.md §五 §十二。
//
// 用法：
//   node scripts/build-desktop-runtime.mjs --platform win32 --arch x64 --out release/runtime
//   node scripts/build-desktop-runtime.mjs --keygen
//
// 签名：DESKTOP_RUNTIME_SIGNING_KEY=<ed25519 私钥 PEM 或文件路径>（只放 CI secret，别进仓库）。
// 没给私钥时仍然产出清单与归档，但不写 .sig —— verify 脚本会因此拒绝，除非显式 --allow-unsigned。

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import * as tar from "tar";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// 清单模块是 tsc 产物（desktop/ → dist/desktop），没构建过要给一句人话而不是 ERR_MODULE_NOT_FOUND
const manifestModule = await import(pathToFileURL(join(repoRoot, "dist", "desktop", "runtime-manifest.js")).href).catch(
	() => null,
);
if (!manifestModule) throw new Error("缺少 dist/desktop/runtime-manifest.js，先跑 `npm run build:desktop`");
const { parseRuntimeManifest, RUNTIME_ALLOWED_TOP_LEVEL } = manifestModule;

// 运行时自带的小资源：缺了会"能起来但功能残"（主题、插件市场、插件 SDK、插件文档）。
// `bin/`（ffmpeg / codec / p2p）属于 natives 载荷，P2 还没下发，见 docs/architecture-desktop-runtime.md。
const DEFAULT_INCLUDE = [
	"dist/server",
	"web/dist",
	"themes",
	"plugin-sdk",
	"plugins/catalog.json",
	"docs/architecture-plugins.md",
	"node_modules",
	"package.json",
];
const REQUIRED_ENTRIES = ["dist/server/index.js", "package.json"];

function parseArgs(argv) {
	const args = { include: DEFAULT_INCLUDE };
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i];
		const next = () => argv[++i];
		switch (key) {
			case "--platform":
				args.platform = next();
				break;
			case "--arch":
				args.arch = next();
				break;
			case "--version":
				args.version = next();
				break;
			case "--natives-version":
				args.nativesVersion = next();
				break;
			case "--protocol":
				args.protocol = Number(next());
				break;
			case "--min-shell":
				args.minShell = Number(next());
				break;
			case "--out":
				args.out = next();
				break;
			case "--base-url":
				args.baseUrl = next();
				break;
			case "--include":
				args.include = next()
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				break;
			case "--from":
				args.from = next();
				break;
			case "--signing-key":
				args.signingKey = next();
				break;
			case "--keygen":
				args.keygen = true;
				break;
			default:
				throw new Error(`未知参数：${key}`);
		}
	}
	return args;
}

function readProtocolVersion() {
	const file = join(repoRoot, "dist", "server", "protocol-version.js");
	if (!existsSync(file)) throw new Error("缺少 dist/server/protocol-version.js，先跑 `npm run build`");
	const match = /PROTOCOL_VERSION\s*=\s*(\d+)/.exec(readFileSync(file, "utf8"));
	if (!match) throw new Error("dist/server/protocol-version.js 里没有 PROTOCOL_VERSION");
	return Number(match[1]);
}

function loadSigningKey(value) {
	if (!value) return null;
	const pem = existsSync(value) ? readFileSync(value, "utf8") : value.replace(/\\n/g, "\n");
	return createPrivateKey(pem);
}

function printKeygen() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
	console.log("# ed25519 密钥对（私钥只进 CI secret，公钥填进壳里）\n");
	console.log("DESKTOP_RUNTIME_SIGNING_KEY=<把下面整段存成 secret>\n");
	console.log(privatePem);
	console.log("# 壳内置公钥（desktop/runtime-public-key.ts 的 RUNTIME_PUBLIC_KEY_PEM）\n");
	console.log(publicPem);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.keygen) {
		printKeygen();
		return;
	}
	const platform = args.platform ?? process.platform;
	const arch = args.arch ?? process.arch;
	const version = args.version ?? pkg.version;
	const protocol = args.protocol ?? readProtocolVersion();
	const minShell = args.minShell ?? 1;
	const outDir = resolve(repoRoot, args.out ?? join("release", "runtime"));
	// 打包源：默认仓库根（本地兜底）；CI 里应指到已按 prod 依赖组装好的目录
	// （electron-builder 的 win-unpacked/resources/app 或 `npm ci --omit=dev` 的副本），
	// 否则会把 devDependencies（electron / vite …）一起打进运行时，白白多几百 MB。
	const fromDir = resolve(repoRoot, args.from ?? ".");
	const baseUrl = (
		args.baseUrl ?? `https://github.com/xing-shuyin/pi-web-ui/releases/download/runtime-${version}`
	).replace(/\/+$/, "");

	for (const item of args.include) {
		if (!existsSync(join(fromDir, item))) throw new Error(`要打包的路径不存在：${join(fromDir, item)}`);
	}
	const topLevel = new Set(args.include.map((item) => item.split("/")[0]));
	for (const top of topLevel) {
		if (!RUNTIME_ALLOWED_TOP_LEVEL.includes(top)) throw new Error(`不在运行时白名单里的顶层目录：${top}`);
	}

	mkdirSync(outDir, { recursive: true });
	const baseName = args.nativesVersion
		? `natives-${args.nativesVersion}-${platform}-${arch}`
		: `core-${version}-${platform}-${arch}`;
	const archivePath = join(outDir, `${baseName}.tar.zst`);
	const tarPath = join(mkdtempSync(join(tmpdir(), "pi-runtime-build-")), "payload.tar");

	try {
		await tar.c({ file: tarPath, cwd: fromDir, portable: true }, args.include);
		await pipeline(createReadStream(tarPath), createZstdCompress(), createWriteStream(archivePath));
	} finally {
		rmSync(dirname(tarPath), { recursive: true, force: true });
	}

	// 归档自检：不许缺入口（装得上但跑不起来的"残废运行时"要在构建时暴露，而不是在用户机器上）
	const entries = [];
	await pipeline(
		createReadStream(archivePath),
		createZstdDecompress(),
		tar.t({ onentry: (entry) => entries.push(entry.path) }),
	);
	for (const required of REQUIRED_ENTRIES) {
		if (!entries.some((entry) => entry === required || entry.endsWith(`/${required}`))) {
			throw new Error(`归档里缺少必需文件：${required}`);
		}
	}

	const archive = readFileSync(archivePath);
	const payload = {
		kind: args.nativesVersion ? "natives" : "core",
		platform,
		arch,
		url: `${baseUrl}/${baseName}.tar.zst`,
		size: archive.length,
		sha256: createHash("sha256").update(archive).digest("hex"),
	};
	const manifest = {
		schemaVersion: 1,
		version,
		nativesVersion: args.nativesVersion ?? null,
		protocol,
		minShell,
		createdAt: new Date().toISOString(),
		payloads: [payload],
	};
	if (!parseRuntimeManifest(manifest)) throw new Error("生成的清单不合规（parseRuntimeManifest 返回 null）");
	// 每平台/架构一个清单（文档 §五）：三个平台的 job 并行跑也不会互相覆盖同名资产。
	const manifestBase = `runtime-${platform}-${arch}`;
	const manifestText = `${JSON.stringify(manifest, null, "\t")}\n`;
	writeFileSync(join(outDir, `${manifestBase}.json`), manifestText);

	const key = loadSigningKey(args.signingKey ?? process.env.DESKTOP_RUNTIME_SIGNING_KEY);
	if (key) {
		const signature = sign(null, Buffer.from(manifestText, "utf8"), key);
		writeFileSync(join(outDir, `${manifestBase}.sig`), `${signature.toString("base64")}\n`);
		const publicPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
		writeFileSync(join(outDir, `${manifestBase}.pub.pem`), publicPem);
	} else {
		rmSync(join(outDir, `${manifestBase}.sig`), { force: true });
		console.warn("⚠ 没给签名私钥：清单未签名（verify 会拒绝，除非 --allow-unsigned）");
	}

	const size = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
	console.log(
		`✔ ${archivePath}  ${size(payload.size)}  sha256=${payload.sha256.slice(0, 16)}…  条目 ${entries.length}`,
	);
	console.log(
		`✔ ${join(outDir, `${manifestBase}.json`)}  version=${version} protocol=${protocol} minShell=${minShell}`,
	);
	if (key) console.log(`✔ 已签名：${manifestBase}.sig（公钥同目录 ${manifestBase}.pub.pem）`);
}

main().catch((error) => {
	console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
