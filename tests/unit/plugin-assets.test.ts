import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildAssetCandidateUrls,
	ensurePluginAsset,
	getPluginAssetStatus,
	type PluginAssetSpec,
} from "../../server/plugin-assets.js";

describe("plugin-assets 重资产流水线单元测试", () => {
	let testDir: string;
	let mockServer: any;
	let mockServerPort: number;
	let mockServerBase: string;

	let validTarGzBuf: Buffer;
	let validTarGzSha: string;

	beforeAll(async () => {
		testDir = mkdtempSync(join(tmpdir(), "pi-asset-test-"));

		const packDir = join(testDir, "pack-src");
		mkdirSync(join(packDir, "artifacts"), { recursive: true });
		writeFileSync(join(packDir, "artifacts", "test-gateway.cjs"), 'console.log("ready");\n');
		const tarOut = join(testDir, "test-pack.tar.gz");
		execFileSync("tar", ["-czf", "./test-pack.tar.gz", "-C", packDir, "artifacts"], {
			cwd: testDir,
			windowsHide: true,
		});
		validTarGzBuf = readFileSync(tarOut);
		validTarGzSha = createHash("sha256").update(validTarGzBuf).digest("hex");

		mockServer = createServer((req, res) => {
			const u = req.url ?? "";
			if (u === "/ok.tar.gz") {
				res.writeHead(200, {
					"Content-Type": "application/gzip",
					"Content-Length": String(validTarGzBuf.length),
				});
				res.end(validTarGzBuf);
			} else if (u === "/fail-first.tar.gz") {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Internal Server Error");
			} else if (u === "/corrupted.tar.gz") {
				res.writeHead(200, { "Content-Type": "application/gzip" });
				res.end(Buffer.from("not a valid tar or altered content"));
			} else {
				res.writeHead(404);
				res.end("Not Found");
			}
		});

		await new Promise<void>((resolve) => {
			mockServer.listen(0, "127.0.0.1", () => {
				mockServerPort = mockServer.address().port;
				mockServerBase = `http://127.0.0.1:${mockServerPort}`;
				resolve();
			});
		});
	});

	afterAll(() => {
		mockServer?.close();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("buildAssetCandidateUrls: 自动增加国内镜像回落与自定义镜像前缀", () => {
		const rawUrls = ["https://github.com/foo/bar/releases/download/v1/asset.tar.gz"];
		const candidates = buildAssetCandidateUrls(rawUrls);

		expect(candidates).toContain(rawUrls[0]);
		expect(candidates.some((u) => u.includes("ghfast.top"))).toBe(true);

		process.env.PI_WEB_ASSET_MIRROR = "https://mirror.internal.org";
		const customCandidates = buildAssetCandidateUrls(rawUrls);
		expect(customCandidates[0]).toBe(
			"https://mirror.internal.org/https://github.com/foo/bar/releases/download/v1/asset.tar.gz",
		);
		delete process.env.PI_WEB_ASSET_MIRROR;
	});

	it("getPluginAssetStatus 与 testFile 探测：未就绪为 false，已存在即为 true", () => {
		const spec: PluginAssetSpec = {
			id: "test-runtime",
			targetDir: "artifacts",
			urls: [`${mockServerBase}/ok.tar.gz`],
			testFile: "test-gateway.cjs",
		};

		const s1 = getPluginAssetStatus(testDir, spec);
		expect(s1.ready).toBe(false);
		expect(s1.downloading).toBe(false);

		const targetDir = join(testDir, "artifacts");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "test-gateway.cjs"), "// mock");

		const s2 = getPluginAssetStatus(testDir, spec);
		expect(s2.ready).toBe(true);
		expect(s2.progress).toBe(100);

		rmSync(targetDir, { recursive: true, force: true });
	});

	it("ensurePluginAsset: SHA-256 强验签与多源回落", async () => {
		const pluginDir = mkdtempSync(join(testDir, "plugin space & (runtime)-"));
		const spec: PluginAssetSpec = {
			id: "runtime-demo",
			targetDir: "artifacts",
			urls: [`${mockServerBase}/fail-first.tar.gz`, `${mockServerBase}/ok.tar.gz`],
			sha256: validTarGzSha,
			testFile: "test-gateway.cjs",
		};

		let progressCalled = false;
		const res = await ensurePluginAsset(pluginDir, spec, {
			onProgress: (p) => {
				progressCalled = true;
				expect(p.downloaded).toBeGreaterThan(0);
			},
		});

		expect(res.ok).toBe(true);
		expect(res.sha256).toBe(validTarGzSha);
		expect(progressCalled).toBe(true);
		expect(existsSync(join(pluginDir, "artifacts", "test-gateway.cjs"))).toBe(true);

		const cached = await ensurePluginAsset(pluginDir, spec);
		expect(cached.cached).toBe(true);
	});

	it("ensurePluginAsset: SHA-256 校验失败防篡改拦截（绝不解压并销毁损坏文件）", async () => {
		const pluginDir = mkdtempSync(join(testDir, "plugin-bad-"));
		const spec: PluginAssetSpec = {
			id: "runtime-bad",
			targetDir: "artifacts",
			urls: [`${mockServerBase}/corrupted.tar.gz`],
			sha256: "0000000000000000000000000000000000000000000000000000000000000000",
			testFile: "test-gateway.cjs",
		};

		await expect(ensurePluginAsset(pluginDir, spec)).rejects.toThrow(/SHA-256/);
		expect(existsSync(join(pluginDir, "artifacts"))).toBe(false);
	});
});
