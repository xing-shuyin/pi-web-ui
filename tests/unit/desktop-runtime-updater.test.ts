import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRuntimeUpdater,
	isAllowedDownloadUrl,
	type RuntimePlan,
	type RuntimeUpdaterEvent,
} from "../../desktop/runtime-updater.js";
import { initialRuntimeUpdaterState, reduceRuntimeUpdater } from "../../desktop/updater.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix = "pi-runtime-updater-") {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function keys() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
	};
}

/** 一个"能跑"的极小归档：只要 dist/server/index.js + protocol-version.js 在就能被 P0 认。 */
async function buildArchive(version: string, protocol = 59): Promise<Buffer> {
	const src = await tempDir("pi-runtime-src-");
	await mkdir(join(src, "dist", "server"), { recursive: true });
	await writeFile(join(src, "dist", "server", "index.js"), `// runtime ${version}\n`);
	await writeFile(join(src, "dist", "server", "protocol-version.js"), `export const PROTOCOL_VERSION = ${protocol};\n`);
	await writeFile(join(src, "package.json"), `${JSON.stringify({ version })}\n`);
	const tarPath = join(src, "payload.tar");
	await tar.c({ file: tarPath, cwd: src, portable: true }, ["dist", "package.json"]);
	const zst = join(src, "payload.tar.zst");
	await pipeline(createReadStream(tarPath), createZstdCompress(), createWriteStream(zst));
	return readFileSync(zst);
}

interface FeedOptions {
	version?: string;
	protocol?: number;
	archive?: Buffer;
	publicPem: string;
	privatePem: string;
	/** 让清单里的 sha256 与真实归档不一致（测 corrupt）。 */
	breakDigest?: boolean;
	/** 篡改清单内容（签名不再是它的签名）。 */
	tamperManifest?: boolean;
}

async function startFeed(options: FeedOptions) {
	const version = options.version ?? "0.200.0";
	const protocol = options.protocol ?? 59;
	const archive = options.archive ?? (await buildArchive(version, protocol));
	const file = `core-${version}-win32-x64.tar.zst`;
	const files = new Map<string, Buffer>();
	const server = createServer((req, res) => {
		const body = files.get((req.url ?? "").split("?")[0] ?? "");
		if (!body) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, { "content-length": body.length, "content-type": "application/octet-stream" });
		res.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	const digest = createHash("sha256").update(archive).digest("hex");
	const manifest = {
		schemaVersion: 1,
		version,
		nativesVersion: null,
		protocol,
		minShell: 1,
		createdAt: null,
		payloads: [
			{
				kind: "core",
				platform: "win32",
				arch: "x64",
				url: `${baseUrl}/${file}`,
				size: archive.length,
				sha256: options.breakDigest ? "0".repeat(64) : digest,
			},
		],
	};
	let manifestText = `${JSON.stringify(manifest, null, "	")}
`;
	const signature = sign(null, Buffer.from(manifestText, "utf8"), options.privatePem).toString("base64");
	if (options.tamperManifest) manifestText = `${manifestText} `;
	files.set("/runtime-win32-x64.json", Buffer.from(manifestText, "utf8"));
	files.set(
		"/runtime-win32-x64.sig",
		Buffer.from(
			`${signature}
`,
			"utf8",
		),
	);
	files.set(`/${file}`, archive);
	return { baseUrl, manifest, archive, file };
}

function makeUpdater(options: {
	runtimeRootDir: string;
	feedUrl: string | null;
	publicKeyPem: string;
	installedVersion?: string | null;
	protocol?: number;
	applySwitch?: (plan: RuntimePlan) => Promise<void>;
}) {
	const events: RuntimeUpdaterEvent[] = [];
	const updater = createRuntimeUpdater({
		runtimeRootDir: options.runtimeRootDir,
		feedUrl: options.feedUrl,
		publicKeyPem: options.publicKeyPem,
		shell: { protocol: options.protocol ?? 59, capability: 1, platform: "win32", arch: "x64" },
		installedVersion: () => options.installedVersion ?? null,
		publish: (event) => events.push(event),
		log: () => {},
	});
	return { updater, events };
}

describe("运行时更新通道（真 HTTP + 真 tar.zst）", () => {
	it("检查 → 下载 → 校验 → 解包暂存：归档落到 <root>/<version>，downloads 清空", async () => {
		const { publicPem, privatePem } = keys();
		const feed = await startFeed({ publicPem, privatePem });
		const root = join(await tempDir(), "runtime");
		const { updater, events } = makeUpdater({ runtimeRootDir: root, feedUrl: feed.baseUrl, publicKeyPem: publicPem });

		expect(await updater.check()).toBe(true);
		expect(updater.getPlan()).toBeNull();
		expect(events.at(-1)).toEqual({ type: "available", version: "0.200.0" });

		expect(await updater.download()).toBe(true);
		const staged = events.filter((event) => event.type === "staged");
		expect(staged).toHaveLength(1);
		expect(events.some((event) => event.type === "progress" && event.percent === 100)).toBe(true);

		const installed = join(root, "0.200.0");
		expect(existsSync(join(installed, "dist", "server", "index.js"))).toBe(true);
		expect(existsSync(join(installed, "dist", "server", "protocol-version.js"))).toBe(true);
		expect(await readdir(root)).toEqual(["0.200.0"]);
		expect(updater.getPlan()).toMatchObject({ version: "0.200.0", protocol: 59 });
	});

	it("签名被篡改 → manifest 错误，且一个字节都不下载", async () => {
		const { publicPem, privatePem } = keys();
		const feed = await startFeed({ publicPem, privatePem, tamperManifest: true });
		const root = join(await tempDir(), "runtime");
		const { updater, events } = makeUpdater({ runtimeRootDir: root, feedUrl: feed.baseUrl, publicKeyPem: publicPem });
		expect(await updater.check()).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "error", code: "manifest" });
		expect(existsSync(root)).toBe(false);
	});

	it("壳里没有公钥 → 一律拒绝（fail closed）", async () => {
		const { publicPem, privatePem } = keys();
		const feed = await startFeed({ publicPem, privatePem });
		const root = join(await tempDir(), "runtime");
		const { updater, events } = makeUpdater({ runtimeRootDir: root, feedUrl: feed.baseUrl, publicKeyPem: "" });
		expect(await updater.check()).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "error", code: "signature" });
	});

	it("协议不一致 / 没有更新 → 闸门直接拒绝（提示先更新壳）", async () => {
		const { publicPem, privatePem } = keys();
		const feed = await startFeed({ publicPem, privatePem, protocol: 60 });
		const root = join(await tempDir(), "runtime");
		const mismatch = makeUpdater({ runtimeRootDir: root, feedUrl: feed.baseUrl, publicKeyPem: publicPem });
		expect(await mismatch.updater.check()).toBe(false);
		expect(mismatch.events.at(-1)).toMatchObject({ type: "error", code: "unsupported" });

		const same = await startFeed({ publicPem, privatePem, version: "0.121.0" });
		const blocked = makeUpdater({
			runtimeRootDir: root,
			feedUrl: same.baseUrl,
			publicKeyPem: publicPem,
			installedVersion: "0.121.0",
		});
		expect(await blocked.updater.check()).toBe(false);
		expect(blocked.events.at(-1)).toMatchObject({ type: "error", code: "unsupported" });
	});

	it("归档摘要与清单不符 → corrupt，且不留半成品目录 / downloads", async () => {
		const { publicPem, privatePem } = keys();
		const feed = await startFeed({ publicPem, privatePem, breakDigest: true });
		const root = join(await tempDir(), "runtime");
		const { updater, events } = makeUpdater({ runtimeRootDir: root, feedUrl: feed.baseUrl, publicKeyPem: publicPem });
		expect(await updater.check()).toBe(true);
		expect(await updater.download()).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "error", code: "corrupt" });
		expect(existsSync(join(root, "0.200.0"))).toBe(false);
		expect(existsSync(join(root, "downloads"))).toBe(false);
	});

	it("apply 成功 → done；applySwitch 抛错 → health 错误（回滚由主进程做）", async () => {
		const { publicPem, privatePem } = keys();
		const feed = await startFeed({ publicPem, privatePem });
		const root = join(await tempDir(), "runtime");
		const { updater, events } = makeUpdater({ runtimeRootDir: root, feedUrl: feed.baseUrl, publicKeyPem: publicPem });
		expect(await updater.check()).toBe(true);
		expect(await updater.download()).toBe(true);

		let applied: RuntimePlan | null = null;
		expect(
			await updater.apply(async (plan) => {
				applied = plan;
			}),
		).toBe(true);
		expect(applied).toMatchObject({ version: "0.200.0", protocol: 59 });
		expect(events.at(-1)).toEqual({ type: "done", version: "0.200.0" });

		expect(
			await updater.apply(async () => {
				throw new Error("server 未在 60000ms 内就绪：health");
			}),
		).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "error", code: "health" });
	});

	it("没有清单就下载 / 没有暂存就切换 → 明确拒绝，而不是空跑", async () => {
		const { publicPem, privatePem } = keys();
		const feed = await startFeed({ publicPem, privatePem });
		const root = join(await tempDir(), "runtime");
		const { updater, events } = makeUpdater({ runtimeRootDir: root, feedUrl: feed.baseUrl, publicKeyPem: publicPem });
		expect(await updater.download()).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "error", code: "manifest" });
		expect(await updater.apply(async () => {})).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "error", code: "manifest" });
		expect(updater.cancel()).toBe(false);
	});

	it("feed 没配 → feed 错误", async () => {
		const { publicPem } = keys();
		const root = join(await tempDir(), "runtime");
		const { updater, events } = makeUpdater({ runtimeRootDir: root, feedUrl: null, publicKeyPem: publicPem });
		expect(await updater.check()).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "error", code: "feed" });
	});
});

describe("下载地址安全", () => {
	it("https 放行；http 只在 feed 也是 http（本地实机测试）时放行", () => {
		expect(isAllowedDownloadUrl("https://example.com/a.tar.zst", null)).toBe(true);
		expect(isAllowedDownloadUrl("http://example.com/a.tar.zst", null)).toBe(false);
		expect(isAllowedDownloadUrl("http://127.0.0.1:9000/a.tar.zst", "http://127.0.0.1:9000")).toBe(true);
		expect(isAllowedDownloadUrl("http://127.0.0.1:9000/a.tar.zst", "https://example.com")).toBe(false);
		expect(isAllowedDownloadUrl("file:///etc/passwd", "http://127.0.0.1:9000")).toBe(false);
		expect(isAllowedDownloadUrl("not a url", "http://127.0.0.1:9000")).toBe(false);
	});
});

describe("运行时通道的状态迁移", () => {
	it("从 idle 推进到 done，错误会清空进度", () => {
		let state = initialRuntimeUpdaterState({ enabled: true, currentVersion: null });
		expect(state.phase).toBe("idle");
		state = reduceRuntimeUpdater(state, { type: "checking" }, 1);
		expect(state.phase).toBe("checking");
		state = reduceRuntimeUpdater(state, { type: "available", version: "v0.200.0" }, 2);
		expect(state).toMatchObject({ phase: "available", targetVersion: "0.200.0", checkedAt: 2 });
		state = reduceRuntimeUpdater(state, { type: "progress", percent: 42.6, transferred: 10, total: 100 }, 3);
		expect(state).toMatchObject({ phase: "downloading", percent: 43, transferred: 10, total: 100 });
		state = reduceRuntimeUpdater(state, { type: "staged", version: "0.200.0" }, 4);
		expect(state).toMatchObject({ phase: "staged", percent: 100 });
		state = reduceRuntimeUpdater(state, { type: "applying", version: "0.200.0" }, 5);
		expect(state.phase).toBe("applying");
		state = reduceRuntimeUpdater(state, { type: "done", version: "0.200.0" }, 6);
		expect(state).toMatchObject({ phase: "done", currentVersion: "0.200.0", targetVersion: null, percent: 100 });
		state = reduceRuntimeUpdater(state, { type: "error", code: "health", message: "boom" }, 7);
		expect(state).toMatchObject({ phase: "error", errorCode: "health", error: "boom", percent: 0 });
	});

	it("取消回到 available（还记着目标版本）或 idle", () => {
		const available = reduceRuntimeUpdater(initialRuntimeUpdaterState({ enabled: true }), {
			type: "available",
			version: "0.200.0",
		});
		expect(reduceRuntimeUpdater(available, { type: "cancelled" })).toMatchObject({ phase: "available", percent: 0 });
		expect(reduceRuntimeUpdater(initialRuntimeUpdaterState({ enabled: true }), { type: "cancelled" }).phase).toBe(
			"idle",
		);
	});

	it("disabled 状态是默认值（这份拷贝不提供运行时更新）", () => {
		expect(initialRuntimeUpdaterState({ enabled: false })).toMatchObject({ enabled: false, phase: "disabled" });
	});
});
